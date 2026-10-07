// altiumts PcbDoc -> a drawable, clickable scene: every primitive as simple shapes on its layer,
// with the net, component and panel facts the panels show. Runs in the parse worker;
// the result is plain data. Coordinates are board mils (absolute, y up); origin gives the board's
// user origin for the mm figures in the panels.
import { getPcbRegionGeometry, type AltiumBinaryPcbDoc } from "altiumts"
import { describeLayer, type PcbLayer } from "./layers"
import { STROKE_GLYPHS } from "./stroke-font"

export type Prim =
	| { t: "seg"; x1: number; y1: number; x2: number; y2: number; w: number } // round-capped stroke
	| { t: "arc"; x: number; y: number; r: number; a0: number; a1: number; w: number } // CCW degrees a0 -> a1
	| { t: "circle"; x: number; y: number; r: number }
	| { t: "poly"; rings: number[][] } // filled, even-odd; rings are flat x,y lists
	| { t: "text"; x: number; y: number; h: number; rot: number; mirror: boolean; text: string; font: string; bold: boolean; italic: boolean }

export type PcbObjectKind = "track" | "arc" | "pad" | "via" | "fill" | "region" | "text" | "body"

export interface PadInfo {
	name: string
	plated: boolean
	smd: boolean
	holeSize: number // mils, 0 for SMD
	shape: string // Round | Rectangular | Rounded Rectangle | Octagonal | Custom
	sizeX: number // mils
	sizeY: number
	rotation: number
}

export interface PcbObject {
	id: number
	kind: PcbObjectKind
	layer: string
	net: string | null
	component: number | null // index into scene.components
	prims: Prim[]
	holes: Prim[] // drill holes, drawn above every layer
	bbox: [number, number, number, number]
	at: [number, number] // location shown in the panel
	pad?: PadInfo
	// Vias and through-hole pads: the copper layers they span (outermost pair). They exist on every
	// copper layer in between, drawn in that layer's colour when it is shown on its own.
	span?: [string, string]
	pour?: boolean // poured copper of a polygon: drawn translucent
	// Pads and vias: the solder mask opening around the copper (mils beyond its edge), per side; null =
	// tented (covered by mask). Used by the 3D view.
	mask?: { top: number | null; bottom: number | null }
	width?: number // track / arc width, mils
	length?: number // track / arc length, mils
}

export interface PcbSceneComponent {
	designator: string
	sourceUniqueId: string
	footprint: string
	footprintDescription: string
	comment: string
	x: number
	y: number
	rotation: number
	side: "top" | "bottom"
	objects: number[] // object ids it owns
	bbox: [number, number, number, number] // everything it owns but text, for framing
	// The box drawn on hover/selection and picked by: the extent of everything the footprint owns
	// except text (pads, silkscreen, courtyard/mechanical, body), measured in the footprint's own
	// frame (as placed at 0°) and turned with it: four corners, x,y each. On an 0805 the box sits
	// 12.8 / 10.8 mil outside the pads = the silkscreen outline.
	box: number[]
	outline: [number, number, number, number] // the box's axis-aligned extent
}

export interface PcbScene {
	origin: [number, number]
	bounds: [number, number, number, number]
	outline: number[] // board shape ring
	cutouts: number[][]
	layers: PcbLayer[] // every layer that has something on it, plus the whole copper stack
	objects: PcbObject[]
	components: PcbSceneComponent[]
}

const mils = (value: unknown) => Number.parseFloat(String(value ?? "0")) || 0
const NO_INDEX = 65535

export function buildPcbScene(doc: AltiumBinaryPcbDoc): PcbScene {
	const d = doc as AltiumBinaryPcbDoc & Record<string, any>
	const boardItems = (d.board?.items as { key: string; value: string }[] | undefined) ?? []
	const boardField = (key: string) => boardItems.find(i => i.key.toUpperCase() === key)?.value
	const origin: [number, number] = [mils(boardField("ORIGINX")), mils(boardField("ORIGINY"))]

	const netNames: (string | null)[] = (d.nets as any[]).map(n => (n.items as any[]).find(i => i.key === "NAME")?.value ?? null)
	const netOf = (r: any) => {
		const n = Number(r.get?.("NET"))
		return Number.isInteger(n) && n !== NO_INDEX ? (netNames[n] ?? null) : null
	}
	const polygonNet = (index: number) => {
		const n = Number((d.polygons as any[])[index]?.get?.("NET"))
		return Number.isInteger(n) && n !== NO_INDEX ? (netNames[n] ?? null) : null
	}
	const componentOf = (r: any) => {
		const c = Number(r.get?.("COMPONENT"))
		return Number.isInteger(c) && c !== NO_INDEX && c < d.components.length ? c : null
	}

	const components: PcbSceneComponent[] = (d.components as any[]).map(c => ({
		designator: c.designator ?? c.get?.("SOURCEDESIGNATOR") ?? "",
		sourceUniqueId: c.sourceUniqueId ?? "",
		footprint: c.footprint ?? c.get?.("PATTERN") ?? "",
		footprintDescription: c.get?.("FOOTPRINTDESCRIPTION") ?? "",
		comment: c.comment ?? "",
		x: mils(c.get?.("X")),
		y: mils(c.get?.("Y")),
		rotation: Number.parseFloat(c.get?.("ROTATION") ?? "0") || 0,
		side: c.get?.("LAYER") === "BOTTOM" ? "bottom" : "top",
		objects: [],
		bbox: [Infinity, Infinity, -Infinity, -Infinity],
		box: [],
		outline: [Infinity, Infinity, -Infinity, -Infinity],
	}))

	const objects: PcbObject[] = []
	const layerKeys = new Set<string>()
	const add = (o: Omit<PcbObject, "id" | "bbox" | "holes"> & { holes?: Prim[] }) => {
		if (o.prims.length === 0) return
		const obj: PcbObject = { ...o, id: objects.length, holes: o.holes ?? [], bbox: primsBox([...o.prims, ...(o.holes ?? [])]) }
		objects.push(obj)
		layerKeys.add(obj.layer)
		if (obj.component !== null) {
			const c = components[obj.component]!
			c.objects.push(obj.id)
			if (obj.kind !== "text") c.bbox = unionBox(c.bbox, obj.bbox)
		}
	}
	const maskRules = solderMaskRules(d.rules as any[])
	const layerFor = (r: any) => (r.get?.("KEEPOUT") === "TRUE" ? "KEEPOUT" : (r.get?.("LAYER") ?? "UNKNOWN"))

	for (const t of d.tracks as any[]) {
		const x1 = mils(t.get("X1")), y1 = mils(t.get("Y1")), x2 = mils(t.get("X2")), y2 = mils(t.get("Y2"))
		const w = mils(t.get("WIDTH"))
		add({ kind: "track", layer: layerFor(t), net: netOf(t), component: componentOf(t), prims: [{ t: "seg", x1, y1, x2, y2, w }], at: [x1, y1], width: w, length: Math.hypot(x2 - x1, y2 - y1) })
	}
	for (const a of d.arcs as any[]) {
		const x = mils(a.get("LOCATION.X") ?? a.get("X")), y = mils(a.get("LOCATION.Y") ?? a.get("Y")), r = mils(a.get("RADIUS"))
		const a0 = Number(a.get("STARTANGLE")) || 0
		const a1 = Number(a.get("ENDANGLE")) || 0
		const sweep = ((a1 - a0) % 360 + 360) % 360 || 360
		const w = mils(a.get("WIDTH"))
		add({ kind: "arc", layer: layerFor(a), net: netOf(a), component: componentOf(a), prims: [{ t: "arc", x, y, r, a0, a1: a0 + sweep, w }], at: [x, y], width: w, length: (r * sweep * Math.PI) / 180 })
	}
	for (const f of d.fills as any[]) {
		const x1 = mils(f.get("X1")), y1 = mils(f.get("Y1")), x2 = mils(f.get("X2")), y2 = mils(f.get("Y2"))
		const rot = Number(f.get("ROTATION")) || 0
		add({ kind: "fill", layer: layerFor(f), net: netOf(f), component: componentOf(f), prims: [rectPoly((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1), Math.abs(y2 - y1), rot, 0)], at: [(x1 + x2) / 2, (y1 + y2) / 2] })
	}
	// Custom-shaped pads: the pad record holds a placeholder (1 mil round) and the copper is a region
	// tied to it by its position in the pad list, counted from 1 (PADINDEX; on every corpus board the
	// region's net is that pad's). That region is the pad's shape.
	const padShapes = new Map<number, Prim[]>()
	for (const r of d.regions as any[]) {
		if (Number(r.get("KIND") ?? 0) !== 0) continue // polygon / board cutouts are not drawn
		const prim = regionPrim(r)
		const padIndex = Number.parseInt(r.get("PADINDEX") ?? "", 10)
		if (Number.isInteger(padIndex) && padIndex > 0 && padIndex !== NO_INDEX) {
			if (prim) padShapes.set(padIndex - 1, [...(padShapes.get(padIndex - 1) ?? []), prim])
			continue
		}
		const polygon = Number(r.get("POLYGON"))
		const pour = Number.isInteger(polygon) && polygon !== NO_INDEX
		// A pour's region carries no net of its own; the polygon has it.
		const net = netOf(r) ?? (pour ? polygonNet(polygon) : null)
		if (prim) add({ kind: "region", layer: layerFor(r), net, component: componentOf(r), prims: [prim], at: firstPoint(prim), pour })
	}
	for (const b of d.componentBodies as any[]) {
		const prim = regionPrim(b)
		if (prim) add({ kind: "body", layer: b.get("LAYER") ?? "MECHANICAL1", net: null, component: componentOf(b), prims: [prim], at: firstPoint(prim) })
	}
	for (const v of d.vias as any[]) {
		const x = mils(v.get("X")), y = mils(v.get("Y"))
		const dia = mils(v.get("DIAMETER")), hole = mils(v.get("HOLESIZE"))
		const span: [string, string] = [copperKey(v.get("STARTLAYER") ?? "TOP"), copperKey(v.get("ENDLAYER") ?? "BOTTOM")]
		add({ kind: "via", layer: "MULTILAYER", span, net: netOf(v), component: null, prims: [{ t: "circle", x, y, r: dia / 2 }], holes: [{ t: "circle", x, y, r: hole / 2 }], at: [x, y], width: dia, pad: { name: "", plated: true, smd: false, holeSize: hole, shape: "Round", sizeX: dia, sizeY: dia, rotation: 0 }, mask: maskOpening(v, maskRules.via) })
	}
	;(d.pads as any[]).forEach((p, k) => addPad(p, padShapes.get(k)))

	for (const t of d.texts as any[]) {
		const component = componentOf(t)
		// Designator and comment strings show only when the component says so (NAMEON / COMMENTON).
		if (component !== null) {
			const owner = (d.components as any[])[component]
			if (t.get("DESIGNATOR") === "TRUE" && owner?.get?.("NAMEON") === "FALSE") continue
			if (t.get("COMMENT") === "TRUE" && owner?.get?.("COMMENTON") === "FALSE") continue
		}
		let text: string = t.text ?? ""
		if (component !== null) {
			if (/^\.designator$/i.test(text)) text = components[component]!.designator
			else if (/^\.comment$/i.test(text)) text = components[component]!.comment
		}
		if (!text) continue
		const x = mils(t.get("X")), y = mils(t.get("Y")), h = mils(t.get("HEIGHT"))
		const rot = Number(t.get("ROTATION")) || 0
		const mirror = t.get("MIRROR") === "TRUE"
		const prims: Prim[] =
			t.get("FONTTYPE") === "1"
				? [{ t: "text", x, y, h, rot, mirror, text, font: t.get("FONTNAME") ?? "Arial", bold: t.get("BOLD") === "TRUE", italic: t.get("ITALIC") === "TRUE" }]
				: strokeText(text, x, y, h, mils(t.get("WIDTH")), rot, mirror)
		add({ kind: "text", layer: layerFor(t), net: null, component, prims, at: [x, y] })
	}

	// Board shape.
	const outlinePoints: { x: number; y: number }[] = d.boardGeometry?.outline?.points ?? []
	const outline = outlinePoints.flatMap(p => [p.x, p.y])
	const cutouts: number[][] = (d.boardGeometry?.cutouts ?? []).map((c: any) => (c.outline?.points ?? []).flatMap((p: any) => [p.x, p.y]))
	let bounds = boxOfRing(outline)
	if (!Number.isFinite(bounds[0])) bounds = objects.reduce((b, o) => unionBox(b, o.bbox), [Infinity, Infinity, -Infinity, -Infinity] as PcbObject["bbox"])

	for (const c of components) {
		const prims = c.objects.flatMap(id => (objects[id]!.kind === "text" ? [] : objects[id]!.prims))
		c.box = rotatedBox(prims, c.x, c.y, c.rotation) ?? cornersOf(c.bbox)
		c.outline = boxOfRing(c.box)
	}
	return { origin, bounds, outline, cutouts, layers: buildLayers(layerKeys, boardItems), objects, components }

	function addPad(p: any, custom?: Prim[]) {
		const x = mils(p.get("X")), y = mils(p.get("Y"))
		const layer: string = p.get("LAYER") ?? "TOP"
		const rot = Number(p.get("ROTATION")) || 0
		const hole = mils(p.get("HOLESIZE"))
		const sizeX = mils(p.get("XSIZE")), sizeY = mils(p.get("YSIZE"))
		const shapeName: string = p.get("SHAPE") ?? "ROUND"
		const alt: string | undefined = p.get("LAYER0ALTSHAPE")
		const radiusPct = Number(p.get("LAYER0CORNERRADIUS") ?? 0)
		const shape = alt === "ROUNDRECT" && shapeName === "ROUND" && radiusPct < 100 ? "ROUNDRECT" : shapeName
		const prim = padPrim(shape, x, y, sizeX, sizeY, rot, (Math.min(sizeX, sizeY) / 2) * (radiusPct / 100))
		const customBox = custom ? primsBox(custom) : null
		const holes: Prim[] = []
		if (hole > 0) {
			const slot = mils(p.get("SLOTLENGTH"))
			if (slot > hole) {
				const a = ((Number(p.get("SLOTROTATION") ?? 0) + rot) * Math.PI) / 180
				const dx = (Math.cos(a) * (slot - hole)) / 2, dy = (Math.sin(a) * (slot - hole)) / 2
				holes.push({ t: "seg", x1: x - dx, y1: y - dy, x2: x + dx, y2: y + dy, w: hole })
			} else holes.push({ t: "circle", x, y, r: hole / 2 })
		}
		add({
			kind: "pad",
			mask: maskOpening(p, maskRules.pad, layer),
			span: layer === "MULTILAYER" ? ["TOP", "BOTTOM"] : undefined,
			layer,
			net: netOf(p),
			component: componentOf(p),
			prims: custom ?? [prim],
			holes,
			at: [x, y],
			pad: {
				name: p.get("NAME") ?? "",
				plated: p.get("PLATED") !== "FALSE",
				smd: hole === 0,
				holeSize: hole,
				shape: custom ? "Custom" : shape === "RECTANGLE" ? "Rectangular" : shape === "ROUNDRECT" ? "Rounded Rectangle" : shape.startsWith("OCTAGON") ? "Octagonal" : "Round",
				sizeX: customBox ? customBox[2] - customBox[0] : sizeX,
				sizeY: customBox ? customBox[3] - customBox[1] : sizeY,
				rotation: rot,
			},
		})
	}
}

// The board's solder mask expansion rules for pads and vias. Only the scopes every board uses are
// understood (All, IsPad, IsVia); the highest-priority matching rule wins.
function solderMaskRules(rules: any[]) {
	const found = { pad: { expansion: 4, tented: false, priority: Infinity }, via: { expansion: 4, tented: false, priority: Infinity } }
	for (const r of rules ?? []) {
		if (r.get?.("RULEKIND") !== "SolderMaskExpansion" || r.get?.("ENABLED") === "FALSE") continue
		const scope = (r.get("SCOPE1EXPRESSION") ?? "All").trim()
		const priority = Number(r.get("PRIORITY")) || 1
		const rule = { expansion: mils(r.get("EXPANSION")), tented: r.get("ISTENTINGTOP") === "TRUE", priority }
		for (const kind of ["pad", "via"] as const) {
			const applies = scope === "All" || (kind === "pad" && scope === "IsPad") || (kind === "via" && scope === "IsVia")
			if (applies && priority < found[kind].priority) found[kind] = rule
		}
	}
	return found
}

function maskOpening(r: any, rule: { expansion: number; tented: boolean }, layer = "MULTILAYER"): PcbObject["mask"] {
	const expansion = r.get("SOLDERMASKEXPANSIONMODE") === "Manual" ? mils(r.get("SOLDERMASKEXPANSION_MANUAL")) : rule.expansion
	const tented = (side: "TOP" | "BOTTOM") => {
		const own = r.get(side === "TOP" ? "TENTEDTOP" : "TENTEDBOTTOM")
		return own !== undefined ? own === "TRUE" : rule.tented
	}
	const on = (side: "TOP" | "BOTTOM") => layer === "MULTILAYER" || layer === side
	return { top: on("TOP") && !tented("TOP") ? expansion : null, bottom: on("BOTTOM") && !tented("BOTTOM") ? expansion : null }
}

function buildLayers(keys: Set<string>, boardItems: { key: string; value: string }[]): PcbLayer[] {
	const field = (k: string) => boardItems.find(i => i.key.toUpperCase() === k)?.value
	const boardName = (v7: number) => field(`LAYER${v7}NAME`)
	// The copper stack, top to bottom, from the V9 stack (falling back to the V7 next-links).
	const stackIds = boardItems.filter(i => /^V9_STACK_LAYER\d+_LAYERID$/.test(i.key)).map(i => Number(i.value))
	const copperFromId = (id: number) => {
		if (id === 16777217) return "TOP"
		if (id === 16842751) return "BOTTOM"
		if (id > 16777217 && id < 16777217 + 31) return `MID-LAYER${id - 16777217}`
		if (id > 16842751 && id < 16842751 + 17) return `PLANE${id - 16842751}`
		return null
	}
	let stack = stackIds.map(copperFromId).filter((k): k is string => k !== null)
	// Copper mid-plane depths, walking the V9 stack from the top.
	const depth = new Map<string, number>()
	let z = 0
	for (let k = 0; ; k++) {
		const id = field(`V9_STACK_LAYER${k}_LAYERID`)
		if (id === undefined) break
		const copper = Number.parseFloat(field(`V9_STACK_LAYER${k}_COPTHICK`) ?? "NaN")
		const dielectric = Number.parseFloat(field(`V9_STACK_LAYER${k}_DIELHEIGHT`) ?? "0") || 0
		const key = copperFromId(Number(id))
		if (key && Number.isFinite(copper)) depth.set(key, z + copper / 2)
		z += Number.isFinite(copper) ? copper : dielectric
	}
	if (stack.length === 0) stack = ["TOP", ...[...keys].filter(k => /^MID/.test(k)).sort(), "BOTTOM"]
	const all = new Set([...stack, ...keys, "TOPSOLDER", "BOTTOMSOLDER", "TOPPASTE", "BOTTOMPASTE", "TOPOVERLAY", "BOTTOMOVERLAY"])
	const out: PcbLayer[] = []
	for (const key of all) {
		if (key === "UNKNOWN") continue
		const base = describeLayer(key, boardName)
		const s = stack.indexOf(key)
		// Copper that is not in the board's stack (stray primitives) still draws, after the stack.
		out.push({ ...base, stack: base.group === "copper" ? (s >= 0 ? s : stack.length + out.length) : -1, z: depth.get(key) })
	}
	return out.sort((a, b) => a.stack - b.stack)
}

// Via start/end layers may use the short names (MID1); primitives use MID-LAYER1.
function copperKey(layer: string): string {
	const mid = /^MID(\d+)$/.exec(layer)
	return mid ? `MID-LAYER${mid[1]}` : layer
}

function padPrim(shape: string, x: number, y: number, w: number, h: number, rot: number, cornerRadius: number): Prim {
	if (shape === "RECTANGLE") return rectPoly(x, y, w, h, rot, 0)
	if (shape === "ROUNDRECT") return rectPoly(x, y, w, h, rot, cornerRadius)
	if (shape.startsWith("OCTAGON")) return octagonPoly(x, y, w, h, rot)
	if (Math.abs(w - h) < 1e-6) return { t: "circle", x, y, r: w / 2 }
	// Oval: a stroke along the long axis, as wide as the short one.
	const a = (rot * Math.PI) / 180
	const long = Math.abs(w - h) / 2
	const [ux, uy] = w > h ? [Math.cos(a), Math.sin(a)] : [-Math.sin(a), Math.cos(a)]
	return { t: "seg", x1: x - ux * long, y1: y - uy * long, x2: x + ux * long, y2: y + uy * long, w: Math.min(w, h) }
}

function rectPoly(cx: number, cy: number, w: number, h: number, rot: number, radius: number): Prim {
	const pts: [number, number][] = []
	const r = Math.min(radius, w / 2, h / 2)
	if (r <= 0.01) pts.push([-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2])
	else {
		const corners: [number, number, number][] = [
			[w / 2 - r, -h / 2 + r, -90],
			[w / 2 - r, h / 2 - r, 0],
			[-w / 2 + r, h / 2 - r, 90],
			[-w / 2 + r, -h / 2 + r, 180],
		]
		for (const [ox, oy, start] of corners)
			for (let k = 0; k <= 6; k++) {
				const a = ((start + k * 15) * Math.PI) / 180
				pts.push([ox + r * Math.cos(a), oy + r * Math.sin(a)])
			}
	}
	return { t: "poly", rings: [transform(pts, cx, cy, rot)] }
}

function octagonPoly(cx: number, cy: number, w: number, h: number, rot: number): Prim {
	const c = Math.min(w, h) / 4
	const pts: [number, number][] = [
		[-w / 2 + c, -h / 2], [w / 2 - c, -h / 2], [w / 2, -h / 2 + c], [w / 2, h / 2 - c],
		[w / 2 - c, h / 2], [-w / 2 + c, h / 2], [-w / 2, h / 2 - c], [-w / 2, -h / 2 + c],
	]
	return { t: "poly", rings: [transform(pts, cx, cy, rot)] }
}

function transform(pts: [number, number][], cx: number, cy: number, rot: number): number[] {
	const a = (rot * Math.PI) / 180
	const c = Math.cos(a), s = Math.sin(a)
	return pts.flatMap(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c])
}

function regionPrim(r: any): Prim | null {
	try {
		const g = getPcbRegionGeometry(r)
		const ring = (c: { points: { x: number; y: number }[] }) => c.points.flatMap(p => [p.x, p.y])
		const rings = [ring(g.outline), ...g.holes.map(ring)].filter(x => x.length >= 6)
		return rings.length ? { t: "poly", rings } : null
	} catch {
		return null
	}
}

// Altium stroke-font text: lines of the given stroke width, anchored at its bottom-left,
// rotated CCW about the anchor, mirrored for bottom-side text.
export function strokeText(text: string, x: number, y: number, height: number, width: number, rot: number, mirror: boolean): Prim[] {
	const cap = height * 0.82
	const pen = Math.max(width, height * 0.05)
	const a = (rot * Math.PI) / 180
	const c = Math.cos(a), s = Math.sin(a)
	const out: Prim[] = []
	let cursor = pen / 2
	for (const ch of text) {
		const g = STROKE_GLYPHS[ch] ?? STROKE_GLYPHS["?"]!
		for (const line of g.strokes) {
			for (let k = 2; k + 1 < line.length; k += 2) {
				const p = (gx: number, gy: number): [number, number] => {
					const lx = (cursor + gx * cap) * (mirror ? -1 : 1)
					const ly = gy * cap + pen / 2
					return [x + lx * c - ly * s, y + lx * s + ly * c]
				}
				const [x1, y1] = p(line[k - 2]!, line[k - 1]!)
				const [x2, y2] = p(line[k]!, line[k + 1]!)
				out.push({ t: "seg", x1, y1, x2, y2, w: pen })
			}
		}
		cursor += g.w * cap
	}
	return out
}

function firstPoint(p: Prim): [number, number] {
	if (p.t === "poly") return [p.rings[0]![0]!, p.rings[0]![1]!]
	if (p.t === "seg") return [p.x1, p.y1]
	return [p.x, p.y]
}

export function primsBox(prims: Prim[]): [number, number, number, number] {
	let b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
	const grow = (x: number, y: number, r: number) => {
		b = [Math.min(b[0], x - r), Math.min(b[1], y - r), Math.max(b[2], x + r), Math.max(b[3], y + r)]
	}
	for (const p of prims) {
		if (p.t === "seg") {
			grow(p.x1, p.y1, p.w / 2)
			grow(p.x2, p.y2, p.w / 2)
		} else if (p.t === "arc") grow(p.x, p.y, p.r + p.w / 2)
		else if (p.t === "circle") grow(p.x, p.y, p.r)
		else if (p.t === "poly") for (const ring of p.rings) for (let k = 0; k + 1 < ring.length; k += 2) grow(ring[k]!, ring[k + 1]!, 0)
		else {
			grow(p.x, p.y, 0)
			grow(p.x + Math.cos((p.rot * Math.PI) / 180) * p.h * p.text.length * 0.6 * (p.mirror ? -1 : 1), p.y + Math.sin((p.rot * Math.PI) / 180) * p.h * p.text.length * 0.6, p.h)
		}
	}
	return b
}

// The extent of some shapes in a frame turned by `deg` about (cx, cy), as the four corners of that
// rectangle back in board coordinates (null: nothing to measure). Strokes keep their width; arcs are
// measured along their sweep.
export function rotatedBox(prims: Prim[], cx: number, cy: number, deg: number): number[] | null {
	const a = (deg * Math.PI) / 180
	const cos = Math.cos(a), sin = Math.sin(a)
	let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
	const grow = (x: number, y: number, r: number) => {
		const dx = x - cx, dy = y - cy
		const u = dx * cos + dy * sin, v = -dx * sin + dy * cos
		u0 = Math.min(u0, u - r)
		v0 = Math.min(v0, v - r)
		u1 = Math.max(u1, u + r)
		v1 = Math.max(v1, v + r)
	}
	for (const p of prims) {
		if (p.t === "seg") {
			grow(p.x1, p.y1, p.w / 2)
			grow(p.x2, p.y2, p.w / 2)
		} else if (p.t === "arc") {
			const sweep = ((((p.a1 - p.a0) % 360) + 360) % 360) || 360
			const steps = Math.max(2, Math.ceil(sweep / 10))
			for (let k = 0; k <= steps; k++) {
				const t = ((p.a0 + (sweep * k) / steps) * Math.PI) / 180
				grow(p.x + p.r * Math.cos(t), p.y + p.r * Math.sin(t), p.w / 2)
			}
		} else if (p.t === "circle") grow(p.x, p.y, p.r)
		else if (p.t === "poly") for (const ring of p.rings) for (let k = 0; k + 1 < ring.length; k += 2) grow(ring[k]!, ring[k + 1]!, 0)
	}
	if (!Number.isFinite(u0)) return null
	const back = (u: number, v: number) => [cx + u * cos - v * sin, cy + u * sin + v * cos]
	return [...back(u0, v0), ...back(u1, v0), ...back(u1, v1), ...back(u0, v1)]
}

export const cornersOf = ([x0, y0, x1, y1]: [number, number, number, number]) => [x0, y0, x1, y0, x1, y1, x0, y1]

// Whether a point is inside a (convex) box of four corners, and the box's area.
export function boxContains(box: number[], x: number, y: number): boolean {
	let sign = 0
	for (let k = 0; k < 4; k++) {
		const ax = box[k * 2]!, ay = box[k * 2 + 1]!, bx = box[((k + 1) % 4) * 2]!, by = box[((k + 1) % 4) * 2 + 1]!
		const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
		if (cross === 0) continue
		if (sign === 0) sign = Math.sign(cross)
		else if (Math.sign(cross) !== sign) return false
	}
	return true
}

export const boxArea = (box: number[]) => Math.hypot(box[2]! - box[0]!, box[3]! - box[1]!) * Math.hypot(box[4]! - box[2]!, box[5]! - box[3]!)

function boxOfRing(ring: number[]): [number, number, number, number] {
	return primsBox(ring.length ? [{ t: "poly", rings: [ring] }] : [])
}

function unionBox(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}
