import { expect, test } from "vitest"
import type { CompiledProject } from "../model/compile"
import { buildIndex, hitTest, primContains } from "./hit"
import { describeLayer, drawOrder, type PcbLayer } from "./layers"
import { netSummaries } from "./nets"
import { strokeText, type PcbObject, type PcbScene } from "./scene"
import { componentSelection, netSelection, pcbHighlight } from "./selection"

const layer = (key: string, stack: number, z?: number): PcbLayer => ({ ...describeLayer(key, () => undefined), stack, z })
const LAYERS: PcbLayer[] = [
	layer("TOP", 0, 1),
	layer("MID-LAYER3", 1, 10),
	layer("MID-LAYER1", 2, 20),
	layer("BOTTOM", 3, 61),
	{ ...layer("TOPOVERLAY", -1) },
	{ ...layer("MULTILAYER", -1) },
]

let nextId = 0
function obj(o: Partial<PcbObject> & Pick<PcbObject, "kind" | "layer" | "prims">): PcbObject {
	const id = nextId++
	return { id, net: null, component: null, holes: [], bbox: [-1e9, -1e9, 1e9, 1e9], at: [0, 0], ...o }
}
function scene(objects: PcbObject[], components: PcbScene["components"] = []): PcbScene {
	objects.forEach((o, k) => (o.id = k))
	for (const o of objects) {
		const xs: number[] = [], ys: number[] = []
		for (const p of o.prims)
			if (p.t === "seg") xs.push(p.x1 - p.w, p.x2 + p.w), ys.push(p.y1 - p.w, p.y2 + p.w)
			else if (p.t === "circle") xs.push(p.x - p.r, p.x + p.r), ys.push(p.y - p.r, p.y + p.r)
		if (xs.length) o.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
	}
	return { origin: [0, 0], bounds: [0, 0, 1000, 1000], outline: [], cutouts: [], layers: LAYERS, objects, components }
}

test("Altium colours follow the layer's identity: Mid-Layer 3 is green whatever it is called", () => {
	expect(describeLayer("MID-LAYER3", () => "GND 1")).toMatchObject({ name: "GND 1", color: "#00cc66", group: "copper" })
	expect(describeLayer("MECHANICAL7", () => "Top Courtyard")).toMatchObject({ name: "Top Courtyard", color: "#008000", group: "mech" })
	expect(describeLayer("TOPOVERLAY", () => undefined).color).toBe("#ffff00")
})

test("the current copper layer is drawn above the other copper; Bottom view reverses the copper", () => {
	const top = drawOrder(LAYERS, "MID-LAYER1", "top")
	expect(top.indexOf("MID-LAYER1")).toBeGreaterThan(top.indexOf("TOP"))
	expect(top.indexOf("TOPOVERLAY")).toBeGreaterThan(top.indexOf("MID-LAYER1"))
	const bottom = drawOrder(LAYERS, "BOTTOM", "bottom")
	expect(bottom.indexOf("TOP")).toBeLessThan(bottom.indexOf("MID-LAYER3"))
})

test("stroke text: one segment per glyph stroke, mirrored text runs the other way", () => {
	const plain = strokeText("I", 0, 0, 100, 10, 0, false)
	expect(plain.length).toBeGreaterThan(0)
	const xs = (prims: ReturnType<typeof strokeText>) => prims.flatMap(p => (p.t === "seg" ? [p.x1, p.x2] : []))
	expect(Math.min(...xs(strokeText("AB", 0, 0, 100, 10, 0, false)))).toBeGreaterThanOrEqual(0)
	expect(Math.max(...xs(strokeText("AB", 0, 0, 100, 10, 0, true)))).toBeLessThanOrEqual(0)
})

test("clicks pick pads and vias first, then copper tracks, then the component", () => {
	const s = scene(
		[
			obj({ kind: "track", layer: "TOP", net: "A", prims: [{ t: "seg", x1: 0, y1: 0, x2: 100, y2: 0, w: 10 }] }),
			obj({ kind: "pad", layer: "TOP", net: "A", component: 0, prims: [{ t: "circle", x: 100, y: 0, r: 20 }] }),
			obj({ kind: "track", layer: "TOPOVERLAY", component: 0, prims: [{ t: "seg", x1: 80, y1: 40, x2: 160, y2: 40, w: 5 }] }),
		],
		[{ designator: "R1", sourceUniqueId: "\\R", footprint: "", footprintDescription: "", comment: "", x: 120, y: 20, rotation: 0, side: "top", objects: [1, 2], bbox: [80, -20, 160, 45], outline: [80, -20, 160, 45] }],
	)
	const idx = buildIndex(s)
	const opts = { tolerance: 1, isShown: () => true, current: "TOP", side: "top" as const }
	expect(hitTest(idx, 95, 2, opts)).toEqual({ kind: "object", id: 1 }) // pad over its track
	expect(hitTest(idx, 40, 3, opts)).toEqual({ kind: "object", id: 0 })
	expect(hitTest(idx, 140, 20, opts)).toEqual({ kind: "component", index: 0 }) // inside the part, no copper
	expect(hitTest(idx, 500, 500, opts)).toBeNull()
	expect(hitTest(idx, 40, 3, { ...opts, isShown: o => o.layer !== "TOP" })).toBeNull()
	// A part with nothing shown in the current layer view (e.g. a bottom part on Top only) is not picked.
	expect(hitTest(idx, 140, 20, { ...opts, isShown: o => o.layer === "BOTTOM" })).toBeNull()
})

test("arcs are hit only along their sweep", () => {
	const arc = { t: "arc" as const, x: 0, y: 0, r: 100, a0: 0, a1: 90, w: 10 }
	expect(primContains(arc, 70.7, 70.7, 0)).toBe(true)
	expect(primContains(arc, -70.7, 70.7, 0)).toBe(false)
})

test("routed length adds each via barrel between the outermost copper layers the net meets there", () => {
	const s = scene([
		obj({ kind: "track", layer: "TOP", net: "N", length: 100, prims: [{ t: "seg", x1: 0, y1: 0, x2: 100, y2: 0, w: 10 }] }),
		obj({ kind: "via", layer: "MULTILAYER", net: "N", at: [100, 0], prims: [{ t: "circle", x: 100, y: 0, r: 12 }] }),
		obj({ kind: "track", layer: "MID-LAYER1", net: "N", length: 50, prims: [{ t: "seg", x1: 100, y1: 0, x2: 150, y2: 0, w: 10 }] }),
	])
	const [n] = netSummaries(s)
	expect(n!.routedLength).toBeCloseTo((100 + 50 + (20 - 1)) * 0.0254, 6)
	expect(n!.layers).toEqual(["TOP", "MID-LAYER1"])
})

test("selections from either view map onto the board", () => {
	const s = scene(
		[
			obj({ kind: "pad", layer: "TOP", net: "VIN_1", component: 0, prims: [{ t: "circle", x: 0, y: 0, r: 5 }] }),
			obj({ kind: "track", layer: "TOP", net: "VIN_1", prims: [{ t: "seg", x1: 0, y1: 0, x2: 50, y2: 0, w: 5 }] }),
		],
		[{ designator: "C1", sourceUniqueId: "\\1SYM\\C", footprint: "", footprintDescription: "", comment: "", x: 0, y: 0, rotation: 0, side: "top", objects: [0], bbox: [-5, -5, 5, 5], outline: [-5, -5, 5, 5] }],
	)
	const compiled = {
		nets: [{ id: 0, netName: "VIN", physicalName: "VIN_1", names: [], occurrences: [], pins: [] }],
		components: [{ id: "Top#3", uniquePath: "\\1SYM\\C" }],
		netAt: {},
	} as unknown as CompiledProject
	expect(netSelection("vin_1", compiled)).toEqual({ kind: "net", netId: 0 })
	expect(netSelection("NOT_IN_SCH", compiled)).toEqual({ kind: "pcbNet", name: "NOT_IN_SCH" })
	expect(componentSelection(s, 0, compiled)).toEqual({ kind: "component", id: "Top#3" })
	expect([...pcbHighlight(s, { kind: "net", netId: 0 }, compiled)!.objects]).toEqual([0, 1])
	const part = pcbHighlight(s, { kind: "component", id: "Top#3" }, compiled)!
	expect([...part.objects]).toEqual([0])
	expect(part.componentBox).toEqual([-5, -5, 5, 5])
})
