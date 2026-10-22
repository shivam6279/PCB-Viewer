// The board as a STEP assembly for mechanical CAD: the board itself as a solid with its holes drilled
// (round ones as true cylinders), the outer copper, solder mask and silkscreen as thin solids on its faces, and
// every part as its own embedded STEP model, copied in whole once per model and placed per part as an
// assembly instance named by designator. Bodies without a model are their outline extruded.
// Coordinates are mm from the board's origin, the board's bottom face at z = 0. Pure: no DOM.
import type { ContourSeg, PcbScene } from "../../pcb/scene"
import type { Board3d, Board3dBody, Board3dColors, Rgb } from "../board3d"
import { outerLayers, primPaths, SCALE, type LayerRegion } from "../board-geometry"
import { partColoursToBodies, renumber, stepEntities, stepRoots, tagProducts, withItem } from "./step-file"
import { modelPlacer, placementOf } from "./step-flatten"
import { contentTag, num, StepWriter, type PathSeg, type Region, type Ring, type Vec3 } from "./step-writer"
import { DEFAULT_STEP_OPTIONS, QUALITY_TOLERANCE, type StepEstimate, type StepExportOptions, type StepQuality } from "./options"

export type { StepEstimate, StepExportOptions }

const MM = 0.0254
const DEG = Math.PI / 180


// The silkscreen's ink: how far it stands off the surface it is printed on (mm). Copper without a mask
// in the stackup: its usual thickness (mm).
const SILK_LIFT = 0.012
const COPPER = 0.035

// The board's own parts in the assembly, by name, and the colour each is written in.
export function layerColours(c: Board3dColors): Record<string, Rgb> {
	return {
		Board: c.core,
		"Top Copper": c.copper,
		"Bottom Copper": c.copper,
		"Plated Holes": c.copper,
		"Top Solder Mask": c.topMask,
		"Bottom Solder Mask": c.bottomMask,
		"Top Silkscreen": c.topSilk,
		"Bottom Silkscreen": c.bottomSilk,
	}
}

export interface StepExportResult {
	bytes: Uint8Array
	parts: number // part instances placed
	models: number // distinct models embedded
	missing: string[] // models that are not STEP or could not be read: their parts are their outline, extruded
}

export function exportStep(
	scene: PcbScene,
	board: Board3d,
	models: Map<string, Uint8Array | null>,
	name: string,
	options: StepExportOptions = DEFAULT_STEP_OPTIONS,
	layersOf: typeof outerLayers = outerLayers,
): StepExportResult {
	const w = new StepWriter()
	const [ox, oy] = scene.origin
	const mm = (x: number, y: number): [number, number] => [(x - ox) * MM, (y - oy) * MM]
	const thickness = board.thickness * MM

	// The assembly's own representation lists the placement of every instance, so it is written last;
	// its product definition comes first so the instances can refer to it.
	const placements: { origin: Vec3; z: Vec3; x: Vec3 }[] = [] // the models', written with the assembly
	const assembly = { definition: 0, representation: 0, axis: 0 }
	const instances: (() => void)[] = []
	const colourOf = layerColours(board.colors)
	// One of the parts written here (the board, a layer, a part with no model): its records apart from
	// every other part's (see beginPart), in its colour, placed as it is. Each is named with a tag of its
	// geometry (the records written so far), so a part from another board, or from another export of
	// this one, is never named the same (see tagProducts).
	// As one part (options.onePart): every body an item of the one part, the models' copied in place.
	const onePart = options.onePart
	const partItems: number[] = []
	const partColours: { item: number; rgb: Rgb }[] = []
	const partStyled: number[] = [] // the models' own colours, copied with their bodies
	const ownPart = (name: string, label: string, repType: string, build: () => number[], rgb: Rgb) => {
		if (onePart) {
			const items = build()
			partItems.push(...items)
			for (const item of items) partColours.push({ item, rgb })
			return
		}
		w.beginPart()
		const items = build()
		if (!items.length) return
		const axis = w.originAxis()
		const p = w.product(`${name} ${w.tag()}`, repType, [axis, ...items])
		w.colour(items.map(item => ({ item, rgb })))
		const n = instances.length + 1
		instances.push(() => w.instance(label, assembly, p, axis, assembly.axis, n))
	}

	// The board's layers at their heights in the stackup, every one a solid (CAD drew the open edges of
	// sheets as lines all over the board). With the solder mask: the board solid is the dielectric; the
	// outer copper its own thickness on it; the mask a solid from the dielectric up to the board's full
	// thickness, open over the pads (so the copper shows only there, and the board's edge is whole); the
	// silkscreen printed on the mask. Parts sit on the mask, at the full thickness, as placed. Without
	// it, the board is the whole thickness and the copper and silkscreen lie on it.
	const z = (depth: number) => thickness - depth * MM
	const copperLayers = board.stack.filter(l => l.kind === "copper")
	const topCu = copperLayers[0], bottomCu = copperLayers[copperLayers.length - 1]
	const topMask = board.stack.find(l => l.kind === "mask" && l.key === "TOPSOLDER")
	const bottomMask = board.stack.find(l => l.kind === "mask" && l.key === "BOTTOMSOLDER")
	const masked = options.mask && topCu && bottomCu && topMask && bottomMask && topCu !== bottomCu
	const heights = masked
		? {
				board: [z(bottomCu.top), z(topCu.bottom)],
				topCopper: [z(topCu.bottom), z(topCu.top)],
				bottomCopper: [z(bottomCu.bottom), z(bottomCu.top)],
				topMask: [z(topCu.bottom), z(topMask.top)],
				bottomMask: [z(bottomMask.bottom), z(bottomCu.top)],
				topSilk: [z(topMask.top), z(topMask.top) + SILK_LIFT],
				bottomSilk: [z(bottomMask.bottom) - SILK_LIFT, z(bottomMask.bottom)],
			}
		: { board: [0, thickness], topCopper: [thickness, thickness + COPPER], bottomCopper: [-COPPER, 0], topMask: [0, 0], bottomMask: [0, 0], topSilk: [thickness, thickness + SILK_LIFT], bottomSilk: [-SILK_LIFT, 0] }

	// The board: its outline with every hole drilled through (vias only when asked). Bare FR4, under a
	// mask or not.
	ownPart("Board", "Board", "ADVANCED_BREP_SHAPE_REPRESENTATION", () => [w.prism(boardRegion(scene, mm, options.viaHoles, options.platedHoles), heights.board[0]!, heights.board[1]!)], colourOf.Board!)

	if (options.copper || options.platedHoles || masked || options.silkscreen) {
		// Under a mask only the copper in its openings shows: by default that is all that is drawn
		// (Cubli's pours and tracks under the mask were half the file).
		const layers = layersOf(scene, board, { viaHoles: options.viaHoles, exposedOnly: !!masked && !options.copperUnderMask, copper: options.copper, tolerance: QUALITY_TOLERANCE[options.quality] ?? QUALITY_TOLERANCE.standard, wholeMask: options.maskOneFace })
		const ring = (pts: number[]) => pts.flatMap((v, i) => (i % 2 ? [] : mm(v, pts[i + 1]!)))
		const region = (r: LayerRegion) => ({ outer: ring(r.outer), holes: r.holes.map(h => ({ t: "poly" as const, pts: ring(h) })) })
		const layer = (label: string, regions: LayerRegion[], [z0, z1]: number[], rgb: Rgb) => {
			if (regions.length) ownPart(label, label, "ADVANCED_BREP_SHAPE_REPRESENTATION", () => regions.map(r => w.prism(region(r), z0!, z1!)), rgb)
		}
		if (options.copper) {
			layer("Top Copper", layers.copper.top, heights.topCopper, colourOf["Top Copper"]!)
			layer("Bottom Copper", layers.copper.bottom, heights.bottomCopper, colourOf["Bottom Copper"]!)
		}
		if (options.platedHoles) {
			// The plating of every drilled plated hole, through the board: a tube from the finished hole out
			// to the board's own hole (drilled wider by the plating; see boardRegion).
			ownPart("Plated Holes", "Plated Holes", "ADVANCED_BREP_SHAPE_REPRESENTATION", () =>
				layers.barrels.map(b => {
					const [x, y] = mm(b.x, b.y)
					return w.prism({ outer: [], outerRing: { t: "circle", x, y, r: b.r * MM + PLATING }, holes: [{ t: "circle", x, y, r: b.r * MM }] }, 0, thickness)
				}),
			colourOf["Plated Holes"]!)
		}
		if (masked) {
			const solids = (regions: LayerRegion[], [z0, z1]: number[]) => regions.map(r => w.prism(region(r), z0!, z1!))
			ownPart("Top Solder Mask", "Top Solder Mask", "ADVANCED_BREP_SHAPE_REPRESENTATION", () => solids(layers.mask.top, heights.topMask), colourOf["Top Solder Mask"]!)
			ownPart("Bottom Solder Mask", "Bottom Solder Mask", "ADVANCED_BREP_SHAPE_REPRESENTATION", () => solids(layers.mask.bottom, heights.bottomMask), colourOf["Bottom Solder Mask"]!)
		}
		if (options.silkscreen) {
			layer("Top Silkscreen", layers.silk.top, heights.topSilk, colourOf["Top Silkscreen"]!)
			layer("Bottom Silkscreen", layers.silk.bottom, heights.bottomSilk, colourOf["Bottom Silkscreen"]!)
		}
	}

	// Each model's records, copied once; their root products, placed per body. A board can embed one file
	// under several models (Camera: 28 models, 16 files): copied once, by its contents' tag.
	const copied = new Map<string, { definition: number; representation: number; axis: number }[] | null>()
	const tags = new Map<string, string>()
	const fileOf = (model: string) => {
		const bytes = models.get(model)
		if (bytes && !tags.has(model)) tags.set(model, contentTag(bytes))
		return tags.get(model) ?? `model ${model}`
	}
	const placers = new Map<string, ReturnType<typeof modelPlacer>>()
	const missing: string[] = []
	let parts = 0
	for (const b of options.parts ? board.bodies : []) {
		const designator = b.component !== null ? scene.components[b.component]?.designator ?? "" : ""
		const at = placement(b, mm, thickness)
		if (b.model && onePart) {
			const file = fileOf(b.model)
			if (!placers.has(file)) {
				const bytes = models.get(b.model)
				placers.set(file, bytes ? modelPlacer(partColoursToBodies(stepEntities(fromLatin1(bytes))), num) : null)
			}
			const place = placers.get(file)
			if (place) {
				const copy = place(w, placementOf(at.origin, at.z, at.x), designator || "Body")
				partItems.push(...copy.bodies)
				partStyled.push(...copy.styled)
				parts++
				continue
			}
			const modelName = board.models.find(m => m.key === b.model)?.name ?? b.model
			if (!missing.includes(modelName)) missing.push(modelName)
		} else if (b.model) {
			const file = fileOf(b.model)
			if (!copied.has(file)) copied.set(file, copyModel(w, models.get(b.model) ?? null, file))
			const roots = copied.get(file)
			if (roots) {
				for (const root of roots) {
					const k = placements.push(at) - 1
					const n = instances.length + 1
					instances.push(() => w.instance(designator, assembly, root, root.axis, placementAxes[k]!, n))
				}
				parts++
				continue
			}
			const modelName = board.models.find(m => m.key === b.model)?.name ?? b.model
			if (!missing.includes(modelName)) missing.push(modelName)
		}
		// No model (or one that is not STEP: a SolidWorks or Parasolid file): the body's outline,
		// extruded over its height, in its colour (grey for an unreadable model, as the 3D view shows it).
		const ring = b.contour[0]
		if (!ring || ring.length < 6) continue
		const pts = ccw(ring.flatMap((v, i) => (i % 2 ? [] : mm(v, ring[i + 1]!))))
		const [z0, z1] = b.side === "top" ? [thickness + b.standoff * MM, thickness + b.height * MM] : [-b.height * MM, -b.standoff * MM]
		if (z1 - z0 <= 0) continue
		ownPart(designator || "Body", designator, "ADVANCED_BREP_SHAPE_REPRESENTATION", () => [w.prism({ outer: pts, holes: [] }, z0, z1)], b.model ? [0.5, 0.5, 0.5] : b.color)
		parts++
	}

	if (onePart) {
		w.product(name, "SHAPE_REPRESENTATION", [w.originAxis(), ...partItems])
		w.colour(partColours)
		if (partStyled.length) w.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${partStyled.map(s => "#" + s).join(",")}),#${w.mmContext()})`)
		return { bytes: w.bytes(`${name}.step`), parts, models: [...placers.values()].filter(Boolean).length, missing }
	}
	// The assembly, its records apart from every part's too: its origin and each model's placement.
	w.beginPart()
	assembly.axis = w.originAxis()
	const placementAxes = placements.map(p => w.axis(p.origin, p.z, p.x))
	Object.assign(assembly, w.product(name, "SHAPE_REPRESENTATION", [assembly.axis, ...placementAxes]))
	for (const add of instances) add()
	return { bytes: w.bytes(`${name}.step`), parts, models: [...copied.values()].filter(Boolean).length, missing }
}

// What each setting adds to the file, for estimateBytes: the board exported with nothing, then with
// one setting at a time (the layers each needs built once). Vias' plating is reckoned per hole from the
// pads'.
export function estimateStep(scene: PcbScene, board: Board3d, models: Map<string, Uint8Array | null>, quality: StepQuality, parts?: number): StepEstimate {
	const built = new Map<string, ReturnType<typeof outerLayers>>()
	const layersOf: typeof outerLayers = (s, b, o) => {
		const key = `${o.viaHoles}/${o.exposedOnly}/${o.copper}/${o.wholeMask}`
		if (!built.has(key)) built.set(key, outerLayers(s, b, o))
		return built.get(key)!
	}
	// (The mask as one face or tiles: the same size within a percent or two.)
	const none: StepExportOptions = { onePart: true, parts: false, copper: false, copperUnderMask: false, platedHoles: false, mask: false, maskOneFace: true, silkscreen: false, viaHoles: false, quality }
	const size = (o: Partial<StepExportOptions>) => exportStep(scene, board, models, "board", { ...none, ...o }, layersOf).bytes.length
	const base = size({})
	const platedHoles = size({ platedHoles: true }) - base
	const padBarrels = scene.objects.filter(o => o.kind !== "via" && o.pad?.plated && o.holes.some(h => h.t === "circle" && h.r > 0)).length
	const vias = scene.objects.filter(o => o.kind === "via" && o.holes.some(h => h.t === "circle" && h.r > 0)).length
	return {
		base,
		parts: parts ?? size({ parts: true }) - base,
		copper: size({ copper: true }) - base,
		mask: size({ mask: true }) - base,
		// The mask's openings follow the copper, so the two are measured together.
		copperAndMask: size({ copper: true, mask: true }) - base,
		allCopperAndMask: size({ copper: true, mask: true, copperUnderMask: true }) - base,
		platedHoles,
		viaBarrels: padBarrels ? Math.round((platedHoles / padBarrels) * vias) : 0,
		silkscreen: size({ silkscreen: true }) - base,
		viaHoles: size({ viaHoles: true }) - base,
	}
}

// Where a body's model goes (Board3dBody's placement rule), as an axis in the export's frame.
function placement(b: Board3dBody, mm: (x: number, y: number) => [number, number], thickness: number): { origin: Vec3; z: Vec3; x: Vec3 } {
	const rot = (v: Vec3): Vec3 => {
		let [x, y, z] = v
		;[y, z] = [y * Math.cos(b.rx * DEG) - z * Math.sin(b.rx * DEG), y * Math.sin(b.rx * DEG) + z * Math.cos(b.rx * DEG)]
		;[x, z] = [x * Math.cos(b.ry * DEG) + z * Math.sin(b.ry * DEG), -x * Math.sin(b.ry * DEG) + z * Math.cos(b.ry * DEG)]
		;[x, y] = [x * Math.cos(b.rz * DEG) - y * Math.sin(b.rz * DEG), x * Math.sin(b.rz * DEG) + y * Math.cos(b.rz * DEG)]
		// The bottom side: turned over about x.
		return b.side === "top" ? [x, y, z] : [x, -y, -z]
	}
	const [x, y] = mm(b.x, b.y)
	const z = b.side === "top" ? thickness + b.dz * MM : -b.dz * MM
	return { origin: [x, y, z], z: rot([0, 0, 1]), x: rot([1, 0, 0]) }
}

// The board outline (counter-clockwise) with its cutouts and every drill hole inside it.
// Plated holes are drilled this much wider than their finished size (mm), the plating filling the
// difference. Drawn at the same radius, the board's wall and the plating's showed through each other.
const PLATING = 0.025

function boardRegion(scene: PcbScene, mm: (x: number, y: number) => [number, number], viaHoles: boolean, plated: boolean): Region {
	const outerMils = scene.outline
	const outer = ccw(outerMils.flatMap((v, i) => (i % 2 ? [] : mm(v, outerMils[i + 1]!))))
	const holes: Ring[] = []
	// Cutouts with their arcs where the board has them (as its outline: see pathRing), else as polygons.
	if (scene.cutoutPaths?.length === scene.cutouts.length && scene.cutoutPaths.some(p => p.some(s => s.arc))) {
		for (const p of scene.cutoutPaths) {
			const ring = pathRing(p, mm, false)
			if (ring) holes.push(ring)
		}
	} else for (const c of scene.cutouts) if (c.length >= 6) holes.push({ t: "poly", pts: cw(c.flatMap((v, i) => (i % 2 ? [] : mm(v, c[i + 1]!)))) })
	const seen = new Set<string>()
	const placed: { x: number; y: number; r: number }[] = []
	for (const o of scene.objects)
		for (const h of viaHoles || o.kind !== "via" ? o.holes : []) {
			if (h.t === "circle") {
				const [x, y] = mm(h.x, h.y)
				const r = h.r * MM + (plated && o.pad?.plated ? PLATING : 0)
				const key = `${x.toFixed(4)},${y.toFixed(4)},${r.toFixed(4)}`
				if (seen.has(key) || r <= 0) continue
				seen.add(key)
				// Only holes wholly inside the board and clear of every other hole make a valid solid.
				if (!ringContainsCircle(outer, x, y, r) || placed.some(p => Math.hypot(p.x - x, p.y - y) < p.r + r)) continue
				placed.push({ x, y, r })
				holes.push({ t: "circle", x, y, r })
				continue
			}
			// Slots and other shapes: their outline as a polygon.
			const paths: { X: number; Y: number }[][] = []
			primPaths(h, paths)
			const ring = paths[0]
			if (!ring) continue
			const pts = cw(ring.flatMap(p => mm(p.X / SCALE, p.Y / SCALE)))
			if (!pts.every((v, i) => i % 2 === 1 || pointInRing(outer, v, pts[i + 1]!))) continue
			holes.push({ t: "poly", pts })
		}
	const outerRing = scene.outlinePath?.some(s => s.arc) ? (pathRing(scene.outlinePath, mm, true) ?? undefined) : undefined
	return { outer, outerRing, holes }
}

// A board outline as drawn, its arcs true arcs (so CAD can mate to them): consecutive arcs on one
// circle made one, a whole circle a circle, the ring turned counter-clockwise (or clockwise, for a
// cutout). Null when it has under two segments.
function pathRing(path: ContourSeg[], mm: (x: number, y: number) => [number, number], counterClockwise: boolean): Ring | null {
	let segs: PathSeg[] = path.map(s => {
		const [x, y] = mm(s.x, s.y)
		if (!s.arc) return { x, y }
		const [cx, cy] = mm(s.arc.cx, s.arc.cy)
		return { x, y, arc: { cx, cy, r: s.arc.r * MM, ccw: s.arc.ccw } }
	})
	// Drop segments of no length (a repeated vertex), unless a whole circle.
	segs = segs.filter((s, i) => {
		const next = segs[(i + 1) % segs.length]!
		return segs.length === 1 || Math.hypot(next.x - s.x, next.y - s.y) > 1e-6 || s.arc
	})
	const same = (a: PathSeg["arc"], b: PathSeg["arc"]) => !!a && !!b && a.ccw === b.ccw && Math.hypot(a.cx - b.cx, a.cy - b.cy) < 1e-6 && Math.abs(a.r - b.r) < 1e-6
	// An arc followed by another on the same circle: the second's start vertex goes.
	for (let merged = true; merged && segs.length > 1; ) {
		merged = false
		for (let i = 0; i < segs.length && segs.length > 1; i++) {
			const j = (i + 1) % segs.length
			if (same(segs[i]!.arc, segs[j]!.arc)) {
				segs.splice(j, 1)
				if (j < i) i--
				merged = true
			}
		}
	}
	if (segs.length === 1 && segs[0]!.arc) return { t: "circle", x: segs[0]!.arc.cx, y: segs[0]!.arc.cy, r: segs[0]!.arc.r }
	if (segs.length < 2) return null
	// Its turning: the area of the polygon through its vertices, each arc's bulge added (the segment
	// between chord and arc, on the arc's side).
	let area = 0
	segs.forEach((s, i) => {
		const n = segs[(i + 1) % segs.length]!
		area += (s.x * n.y - n.x * s.y) / 2
		if (s.arc) {
			const chord = Math.hypot(n.x - s.x, n.y - s.y)
			const half = Math.asin(Math.min(1, chord / (2 * s.arc.r)))
			// The arc's sweep: the short way unless the centre lies on the arc's own side of the chord.
			const side = (n.x - s.x) * (s.arc.cy - s.y) - (n.y - s.y) * (s.arc.cx - s.x)
			const sweep = (side > 0) === s.arc.ccw ? 2 * half : 2 * Math.PI - 2 * half
			area += ((s.arc.ccw ? 1 : -1) * s.arc.r * s.arc.r * (sweep - Math.sin(sweep))) / 2
		}
	})
	if (area > 0 === counterClockwise) return { t: "path", segs }
	// Reversed: each segment now runs from the next vertex back, its arc turning the other way.
	const reversed: PathSeg[] = []
	for (let i = segs.length - 1; i >= 0; i--) {
		const from = segs[(i + 1) % segs.length]!, s = segs[i]!
		reversed.push(s.arc ? { x: from.x, y: from.y, arc: { ...s.arc, ccw: !s.arc.ccw } } : { x: from.x, y: from.y })
	}
	return { t: "path", segs: reversed }
}

function signedArea(pts: number[]): number {
	let a = 0
	for (let i = 0; i < pts.length; i += 2) {
		const j = (i + 2) % pts.length
		a += pts[i]! * pts[j + 1]! - pts[j]! * pts[i + 1]!
	}
	return a / 2
}

// A ring without repeated points (consecutive or closing), turned to the orientation asked for.
function oriented(pts: number[], counterClockwise: boolean): number[] {
	const out: number[] = []
	for (let i = 0; i < pts.length; i += 2) {
		const x = pts[i]!, y = pts[i + 1]!
		const n = out.length
		if (n && Math.hypot(out[n - 2]! - x, out[n - 1]! - y) < 1e-6) continue
		out.push(x, y)
	}
	while (out.length > 4 && Math.hypot(out[0]! - out[out.length - 2]!, out[1]! - out[out.length - 1]!) < 1e-6) out.length -= 2
	if (signedArea(out) > 0 !== counterClockwise) {
		const r: number[] = []
		for (let i = out.length - 2; i >= 0; i -= 2) r.push(out[i]!, out[i + 1]!)
		return r
	}
	return out
}
const ccw = (pts: number[]) => oriented(pts, true)
const cw = (pts: number[]) => oriented(pts, false)

function pointInRing(ring: number[], x: number, y: number): boolean {
	let inside = false
	for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
		const xi = ring[i]!, yi = ring[i + 1]!, xj = ring[j]!, yj = ring[j + 1]!
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
	}
	return inside
}

function ringContainsCircle(ring: number[], x: number, y: number, r: number): boolean {
	if (!pointInRing(ring, x, y)) return false
	for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
		const ax = ring[j]!, ay = ring[j + 1]!, bx = ring[i]!, by = ring[i + 1]!
		const dx = bx - ax, dy = by - ay
		const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
		if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= r) return false
	}
	return true
}

// A model's records, renumbered into the writer; its root products (each with an axis to place it by,
// added to its representation when it has none). Null when the file is unreadable or has no product.
// A colour on a whole part goes onto its bodies (see partColoursToBodies). Its products are named with a
// tag of the file (`tag`, see tagProducts): the same model on two boards stays one part.
function copyModel(w: StepWriter, bytes: Uint8Array | null, tag: string): { definition: number; representation: number; axis: number }[] | null {
	if (!bytes) return null
	const entities = tagProducts(partColoursToBodies(stepEntities(fromLatin1(bytes))), tag)
	const roots = stepRoots(entities)
	if (!roots.length) return null
	const first = w.reserve(entities.length + roots.length * 4)
	const ids = new Map<number, number>()
	entities.forEach((e, i) => ids.set(e.id, first + i))
	const map = (id: number) => ids.get(id) ?? id
	let spare = first + entities.length
	const patched = new Map<number, string>()
	const extra: string[] = []
	const out = roots.map(root => {
		let axis = root.axis !== null ? map(root.axis) : null
		if (axis === null) {
			// An axis at the model's origin, in the model's own units, added to its representation.
			const [p, z, x, a] = [spare++, spare++, spare++, spare++]
			extra.push(`#${p}=CARTESIAN_POINT('',(0.,0.,0.));`, `#${z}=DIRECTION('',(0.,0.,1.));`, `#${x}=DIRECTION('',(1.,0.,0.));`, `#${a}=AXIS2_PLACEMENT_3D('',#${p},#${z},#${x});`)
			axis = a
			const rep = entities.find(e => e.id === root.representation)!
			// (Kept renumbered: a second root sharing the representation adds to the patched record.)
			patched.set(rep.id, withItem(patched.get(rep.id) ?? renumber(rep.body, map), a))
		}
		return { definition: map(root.productDefinition), representation: map(root.representation), axis }
	})
	for (const e of entities) w.push(`#${map(e.id)}=${patched.get(e.id) ?? renumber(e.body, map)};`)
	for (const line of extra) w.push(line)
	return out
}

// STEP files are 8-bit text: decoded byte for byte, so nothing in a model is altered.
function fromLatin1(bytes: Uint8Array): string {
	let s = ""
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return s
}


