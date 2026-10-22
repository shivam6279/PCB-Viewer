// The export dialog's preview board: a small patch of board, made up, in the same form a real board
// is read into (a scene and its 3D data), so the preview is the exporter's own output. It has
// something for every setting: an 0603 resistor on its pads, a 2-pin header in plated holes, an empty
// plated mounting hole, an untented and a tented via, tracks across the board, a ground pour, and
// silkscreen. The part models are in sample/ (see sample/NOTICE.md). Coordinates are mils, y up.
import { strokeText, type PadInfo, type PcbObject, type PcbScene, type Prim } from "../../pcb/scene"
import { STROKE_GLYPHS } from "../../pcb/stroke-font"
import type { PcbLayer } from "../../pcb/layers"
import type { Board3d, Board3dBody } from "../board3d"
import { pourRings } from "../board-geometry"

export const SAMPLE_MODELS = {
	resistor: { key: "sample-r0603", name: "R_0603.step", url: new URL("./sample/R_0603.step", import.meta.url).href },
	header: { key: "sample-header", name: "PinHeader_1x02_P2.54mm_Vertical.step", url: new URL("./sample/PinHeader_1x02_P2.54mm_Vertical.step", import.meta.url).href },
}

// The preview board's colours (its mask is drawn see-through in the preview: see renderStepPreview).
export const SAMPLE_COLORS: Board3d["colors"] = {
	background: [0.8, 0.8, 0.8],
	core: [0.78, 0.69, 0.47],
	coreOpacity: 1,
	prepreg: [0.78, 0.69, 0.47],
	prepregOpacity: 1,
	topMask: [0.11, 0.4, 0.2],
	topMaskOpacity: 0.9,
	bottomMask: [0.11, 0.4, 0.2],
	bottomMaskOpacity: 0.9,
	copper: [0.86, 0.66, 0.27],
	topSilk: [0.97, 0.97, 0.95],
	bottomSilk: [0.97, 0.97, 0.95],
}

const W = 500
const H = 320
const TRACK = 10
const CLEARANCE = 10 // the pour's, from copper on other nets
const SILK = 6 // outline width
const TEXT = 3.5 // designators' stroke width

export function sampleBoard(): { scene: PcbScene; board: Board3d } {
	const objects: PcbObject[] = []
	const add = (o: Omit<PcbObject, "id" | "bbox" | "at" | "net"> & { net?: string | null }) => {
		const box = boxOf([...o.prims, ...o.holes])
		objects.push({ net: null, ...o, id: objects.length, bbox: box, at: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] })
	}
	const rect = (x: number, y: number, w: number, h: number): Prim => ({ t: "poly", rings: [[x - w / 2, y - h / 2, x + w / 2, y - h / 2, x + w / 2, y + h / 2, x - w / 2, y + h / 2]] })
	const pad = (name: string, smd: boolean, holeSize: number, shape: string, sizeX: number, sizeY: number): PadInfo => ({ name, plated: true, smd, holeSize, shape, sizeX, sizeY, rotation: 0 })
	const track = (layer: string, w: number, net: string | null, ...pts: number[]) => {
		const prims: Prim[] = []
		for (let i = 0; i + 3 < pts.length; i += 2) prims.push({ t: "seg", x1: pts[i]!, y1: pts[i + 1]!, x2: pts[i + 2]!, y2: pts[i + 3]!, w })
		add({ kind: "track", layer, net, component: null, prims, holes: [], width: w })
	}
	// A plated through-hole pad (round, or square for a header's pin 1), or a via; tented: no mask
	// opening over it.
	const throughHole = (x: number, y: number, size: number, drill: number, o: { square?: boolean; component?: number; kind?: "pad" | "via"; net?: string; tented?: boolean } = {}) =>
		add({
			kind: o.kind ?? "pad",
			layer: "MULTILAYER",
			net: o.net ?? null,
			component: o.component ?? null,
			prims: [o.square ? rect(x, y, size, size) : { t: "circle", x, y, r: size / 2 }],
			holes: [{ t: "circle", x, y, r: drill / 2 }],
			pad: pad("1", false, drill, o.square ? "Rectangular" : "Round", size, size),
			span: ["TOP", "BOTTOM"],
			mask: o.tented ? { top: null, bottom: null } : { top: 2, bottom: 2 },
		})
	const silk = (component: number | null, prims: Prim[]) => add({ kind: "text", layer: "TOPOVERLAY", component, prims, holes: [] })
	// Text centred on x, its baseline at y.
	const centred = (text: string, x: number, y: number, h: number) => strokeText(text, x - textWidth(text, h) / 2, y, h, 2.5, 0, false)

	// R1, an 0603 resistor (the pads and model of a board that uses it).
	const r1 = { x: 110, y: 70 }
	for (const dx of [-25.6, 25.6]) add({ kind: "pad", layer: "TOP", component: 0, prims: [rect(r1.x + dx, r1.y, 33.5, 37.4)], holes: [], pad: pad(dx < 0 ? "1" : "2", true, 0, "Rectangular", 33.5, 37.4), mask: { top: 4, bottom: null } })
	// J1, a 2-pin 2.54 mm header: 1.7 mm pads, 1 mm drills, pin 1 square.
	const j1 = { x: 90, y: 235 }
	throughHole(j1.x, j1.y, 67, 39, { square: true, component: 1 })
	throughHole(j1.x + 100, j1.y, 67, 39, { component: 1 })
	// A plated mounting hole on the ground pour, and two vias: one open to the mask, one tented over.
	throughHole(430, 250, 110, 65, { net: "GND" })
	const open = { x: 300, y: 70 }
	const tented = { x: 400, y: 70 }
	throughHole(open.x, open.y, 30, 15, { kind: "via" })
	throughHole(tented.x, tented.y, 30, 15, { kind: "via", tented: true })
	// Tracks: R1 to the open via and off the board's left edge; the tented via off its right edge; two
	// right across the board; J1's pin 1 off its back edge, and pin 2 down to the nearer of the two.
	track("TOP", TRACK, null, r1.x + 25.6, r1.y, open.x, open.y)
	track("TOP", TRACK, null, tented.x, tented.y, W, tented.y)
	track("TOP", TRACK, null, r1.x - 25.6, r1.y, 0, r1.y)
	track("TOP", TRACK, null, 0, 140, W, 140)
	track("TOP", TRACK, null, 0, 160, W, 160)
	track("TOP", TRACK, null, j1.x, j1.y, 20, j1.y, 20, H)
	track("TOP", TRACK, null, j1.x + 100, j1.y, 270, j1.y, 270, 160)
	// The ground pour over the board's right side, clear of every other net's copper.
	const keepouts = objects.filter(o => o.net !== "GND" && (o.layer === "TOP" || o.span)).flatMap(o => o.prims)
	add({ kind: "region", layer: "TOP", net: "GND", component: null, pour: true, prims: [{ t: "poly", rings: pourRings([230, 10, W - 10, 10, W - 10, H - 10, 230, H - 10], keepouts, CLEARANCE) }], holes: [] })
	// Silkscreen: R1's footprint's own (a bracket each side, clear of the pads, and a line between them),
	// J1's outline, the designators, and what the vias are.
	const r1Silk = [
		[-50, -20, -50, -27.56, 50, -27.56, 50, -20],
		[-50, 20, -50, 27.56, 50, 27.56, 50, 20],
		[0, -27.56, 0, 27.56],
	]
	for (const line of r1Silk) track("TOPOVERLAY", 5.9, null, ...line.map((v, k) => v + (k % 2 ? r1.y : r1.x)))
	track("TOPOVERLAY", SILK, null, 35, 185, 245, 185, 245, 285, 35, 285, 35, 185)
	silk(0, strokeText("R1", r1.x - 50, r1.y + 38, 20, TEXT, 0, false))
	silk(1, strokeText("J1", 37, 292, 20, TEXT, 0, false))
	silk(null, centred("UNTENTED", open.x, 94, 14))
	silk(null, centred("TENTED", tented.x, 94, 14))

	const component = (designator: string, x: number, y: number, owned: number[]) => ({
		designator,
		logicalDesignator: designator,
		sourceUniqueId: designator,
		footprint: "",
		footprintDescription: "",
		comment: "",
		x,
		y,
		rotation: 0,
		side: "top" as const,
		objects: owned,
		bbox: [x, y, x, y] as [number, number, number, number],
		box: [],
		outline: [x, y, x, y] as [number, number, number, number],
	})
	const scene: PcbScene = {
		origin: [0, 0],
		bounds: [0, 0, W, H],
		outline: [0, 0, W, 0, W, H, 0, H],
		cutouts: [],
		layers: LAYERS,
		objects,
		components: [component("R1", r1.x, r1.y, objects.filter(o => o.component === 0).map(o => o.id)), component("J1", j1.x, j1.y, objects.filter(o => o.component === 1).map(o => o.id))],
	}

	const body = (component: number, model: string, at: { x: number; y: number; rx: number; rz: number }, contour: number[], height: number): Board3dBody => ({ component, side: "top", contour: [contour], standoff: 0, height, color: [0.3, 0.3, 0.3], opacity: 1, model, ry: 0, dz: 0, ...at })
	const board: Board3d = {
		thickness: 63,
		// Mask, copper, core, copper, mask: depths below the top, mils.
		stack: [
			{ kind: "mask", key: "TOPSOLDER", name: "Top Solder", top: 0, bottom: 0.4, core: false },
			{ kind: "copper", key: "TOP", name: "Top Layer", top: 0.4, bottom: 1.8, core: false },
			{ kind: "dielectric", key: "CORE", name: "Core", top: 1.8, bottom: 61.2, core: true },
			{ kind: "copper", key: "BOTTOM", name: "Bottom Layer", top: 61.2, bottom: 62.6, core: false },
			{ kind: "mask", key: "BOTTOMSOLDER", name: "Bottom Solder", top: 62.6, bottom: 63, core: false },
		],
		colors: SAMPLE_COLORS,
		bodies: [
			// The resistor's model is drawn y up, from one long edge: stood up, that edge on the pads' far side.
			body(0, SAMPLE_MODELS.resistor.key, { x: r1.x, y: r1.y + 15.75, rx: 90, rz: 0 }, [r1.x - 32, r1.y - 16, r1.x + 32, r1.y - 16, r1.x + 32, r1.y + 16, r1.x - 32, r1.y + 16], 18),
			// The header's model runs from pin 1 down its y axis: turned so pin 2 lies along +x.
			body(1, SAMPLE_MODELS.header.key, { x: j1.x, y: j1.y, rx: 0, rz: 90 }, [j1.x - 50, j1.y - 50, j1.x + 150, j1.y - 50, j1.x + 150, j1.y + 50, j1.x - 50, j1.y + 50], 336),
		],
		models: [
			{ key: SAMPLE_MODELS.resistor.key, name: SAMPLE_MODELS.resistor.name },
			{ key: SAMPLE_MODELS.header.key, name: SAMPLE_MODELS.header.name },
		],
	}
	return { scene, board }
}

// The width strokeText gives text of a height.
function textWidth(text: string, h: number): number {
	let w = 0
	for (const ch of text) w += (STROKE_GLYPHS[ch] ?? STROKE_GLYPHS["?"]!).w
	return w * h * 0.82
}

const layer = (key: string, name: string, group: PcbLayer["group"], side: PcbLayer["side"], stack = 0): PcbLayer => ({ key, name, color: "#ffffff", group, side, stack })
const LAYERS: PcbLayer[] = [
	layer("TOP", "Top Layer", "copper", "top", 0),
	layer("BOTTOM", "Bottom Layer", "copper", "bottom", 1),
	layer("TOPOVERLAY", "Top Overlay", "silk", "top"),
	layer("TOPSOLDER", "Top Solder", "mask", "top"),
	layer("BOTTOMSOLDER", "Bottom Solder", "mask", "bottom"),
	layer("MULTILAYER", "Multi-Layer", "other", "none"),
]

function boxOf(prims: Prim[]): [number, number, number, number] {
	const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
	const grow = (x: number, y: number, r = 0) => {
		b[0] = Math.min(b[0], x - r)
		b[1] = Math.min(b[1], y - r)
		b[2] = Math.max(b[2], x + r)
		b[3] = Math.max(b[3], y + r)
	}
	for (const p of prims) {
		if (p.t === "seg") (grow(p.x1, p.y1, p.w / 2), grow(p.x2, p.y2, p.w / 2))
		else if (p.t === "circle" || p.t === "arc") grow(p.x, p.y, p.r)
		else if (p.t === "poly") for (const ring of p.rings) for (let i = 0; i + 1 < ring.length; i += 2) grow(ring[i]!, ring[i + 1]!)
	}
	return b
}
