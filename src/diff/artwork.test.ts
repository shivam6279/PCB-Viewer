import { expect, test } from "vitest"
import type { PcbObject, PcbScene, PcbSceneComponent, Prim } from "../pcb/scene"
import { diffArtwork, gather, pairCopper } from "./artwork"

let nextId = 0
const obj = (kind: PcbObject["kind"], layer: string, prims: Prim[], extra: Partial<PcbObject> = {}): PcbObject => {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
	for (const p of prims) {
		const pts = p.t === "seg" ? [p.x1 - p.w / 2, p.y1 - p.w / 2, p.x2 + p.w / 2, p.y2 + p.w / 2] : p.t === "poly" ? p.rings[0]! : []
		for (let i = 0; i < pts.length; i += 2) (x0 = Math.min(x0, pts[i]!)), (x1 = Math.max(x1, pts[i]!)), (y0 = Math.min(y0, pts[i + 1]!)), (y1 = Math.max(y1, pts[i + 1]!))
	}
	return { id: nextId++, kind, layer, net: "N", component: null, prims, holes: [], bbox: [x0, y0, x1, y1], at: [0, 0], ...extra }
}
const seg = (x1: number, x2: number, y = 0, w = 10): Prim => ({ t: "seg", x1, y1: y, x2, y2: y, w })
const square = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1]

const board = (objects: PcbObject[]): PcbScene => ({
	origin: [0, 0],
	bounds: [-1000, -1000, 1000, 1000],
	outline: square(-1000, -1000, 1000, 1000),
	cutouts: [],
	layers: [
		{ key: "TOP", name: "Top Layer", color: "#f00", group: "copper", side: "top", stack: 0 },
		{ key: "BOTTOM", name: "Bottom Layer", color: "#00f", group: "copper", side: "bottom", stack: 1 },
	],
	objects: objects.map((o, i) => ({ ...o, id: i })),
	components: [],
})

test("one track and the same run in three pieces are the same artwork", () => {
	const d = diffArtwork(board([obj("track", "TOP", [seg(0, 300)])]), board([obj("track", "TOP", [seg(0, 100)]), obj("track", "TOP", [seg(100, 160)]), obj("track", "TOP", [seg(160, 300)])]))
	expect(d.areas).toEqual([])
})

test("a track moved a little is one change: the old copper on A, the new on B", () => {
	const d = diffArtwork(board([obj("track", "TOP", [seg(0, 200, 0)])]), board([obj("track", "TOP", [seg(0, 200, 20)])]))
	expect(d.areas).toHaveLength(1)
	expect(d.areas[0]).toMatchObject({ layers: ["TOP"], a: 1, b: 1 })
	expect(d.pieces.every(p => p.layer === "TOP")).toBe(true)
})

test("a pour re-poured with one notch: only the notch changed, whatever else the pour object says", () => {
	const full = square(-500, -500, 500, 500)
	// Same area, its outline drawn from another corner (a re-pour lists the points afresh).
	const again = [500, -500, 500, 500, -500, 500, -500, -500]
	const notched = [-500, -500, 500, -500, 500, 500, 120, 500, 120, 450, 80, 450, 80, 500, -500, 500]
	const pour = (ring: number[]) => obj("region", "BOTTOM", [{ t: "poly", rings: [ring] }], { pour: true })
	expect(diffArtwork(board([pour(full)]), board([pour(again)])).areas).toEqual([])
	const d = diffArtwork(board([pour(full)]), board([pour(notched)]))
	expect(d.areas).toHaveLength(1)
	const [x0, y0, x1, y1] = d.areas[0]!.box
	expect([x0, y0, x1, y1].map(Math.round)).toEqual([80, 450, 120, 500])
	expect(d.areas[0]).toMatchObject({ layers: ["BOTTOM"], a: 1, b: 0 })
})

test("hairline slivers are not changes", () => {
	// Shifted by a fifth of a mil: what differs is a sliver along each edge.
	const d = diffArtwork(board([obj("fill", "TOP", [{ t: "poly", rings: [square(0, 0, 100, 100)] }])]), board([obj("fill", "TOP", [{ t: "poly", rings: [square(0.2, 0, 100.2, 100)] }])]))
	expect(d.areas).toEqual([])
})

test("boxes near each other are one place, on any layer; far apart, two; never wider than a cell", () => {
	const { groups, of } = gather([{ box: [0, 0, 10, 10] }, { box: [30, 0, 40, 10] }, { box: [500, 0, 510, 10] }])
	expect(groups).toHaveLength(2)
	expect(of[0]).toBe(of[1])
	expect(groups[of[0]!]).toEqual([0, 0, 40, 10])
	// A row of changes 20 mils apart along 2000 mils: not one place, but none wider than 300.
	const row = gather(Array.from({ length: 100 }, (_, i) => ({ box: [i * 20, 0, i * 20 + 5, 5] as [number, number, number, number] })))
	expect(row.groups.length).toBeGreaterThan(6)
	expect(row.groups.every(([x0, , x1]) => x1 - x0 <= 300)).toBe(true)
})

const part = (designator: string, x: number, objects: number[]): PcbSceneComponent => ({
	designator,
	logicalDesignator: designator,
	sourceUniqueId: `\\${designator}`,
	footprint: "0603",
	footprintDescription: "",
	comment: "",
	x,
	y: 0,
	rotation: 0,
	side: "top",
	objects,
	bbox: [x - 30, -20, x + 30, 20],
	box: [x - 30, -20, x + 30, -20, x + 30, 20, x - 30, 20],
	outline: [x - 30, -20, x + 30, 20],
})

test("a part moved is one change, its outline in both places; not its pads", () => {
	const pads = (x: number) => [obj("pad", "TOP", [{ t: "poly", rings: [square(x - 25, -10, x - 15, 10)] }], { component: 0 }), obj("pad", "TOP", [{ t: "poly", rings: [square(x + 15, -10, x + 25, 10)] }], { component: 0 })]
	const at = (x: number) => ({ ...board(pads(x)), components: [part("R5", x, [0, 1])] })
	const d = diffArtwork(at(0), at(200))
	expect(d.pieces).toEqual([])
	expect(d.parts).toMatchObject([{ designator: "R5", kind: "moved" }])
	expect(d.areas).toHaveLength(1)
	expect(d.areas[0]!.parts).toEqual([0])
	// Not moved: nothing.
	expect(diffArtwork(at(0), at(0)).areas).toEqual([])
})

test("copper layers are paired by name; a layer in only one board is one change", () => {
	const a = board([obj("track", "MID-LAYER3", [seg(0, 300)])])
	a.layers.push({ key: "MID-LAYER3", name: "L2 - GND", color: "#0f0", group: "copper", side: "inner", stack: 1 })
	const b = board([obj("track", "MID-LAYER2", [seg(0, 300)]), obj("track", "MID-LAYER1", [seg(0, 300, 100)])])
	b.layers.push({ key: "MID-LAYER2", name: "L2 - GND", color: "#0f0", group: "copper", side: "inner", stack: 1 }, { key: "MID-LAYER1", name: "L5 - GND", color: "#0f0", group: "copper", side: "inner", stack: 2 })
	expect(pairCopper(a, b).copper.get("MID-LAYER3")).toBe("MID-LAYER2")
	const d = diffArtwork(a, b)
	// The same track on L2 under another key is no change; L5's copper is not listed piece by piece.
	expect(d.pieces).toEqual([])
	expect(d.areas.map(c => c.layer)).toEqual([{ kind: "removed", name: "L5 - GND" }])
})

test("a part moved with its tracks is one block move; nothing else is left", () => {
	const at = (x: number) => {
		const s = board([
			obj("pad", "TOP", [{ t: "poly", rings: [square(x - 25, -10, x - 15, 10)] }], { component: 0 }),
			obj("track", "TOP", [seg(x + 30, x + 90, 0)]),
			obj("track", "TOP", [seg(x + 90, x + 90.01, 40)]),
			obj("track", "TOP", [seg(x - 90, x - 30, 0)]),
		])
		return { ...s, components: [part("U1", x, [0])] }
	}
	const d = diffArtwork(at(0), at(300))
	expect(d.moves).toHaveLength(1)
	expect(d.moves[0]).toMatchObject({ dx: 300, dy: 0, parts: ["U1"], count: 4 })
	expect(d.pieces).toEqual([])
	expect(d.parts).toEqual([])
	expect(d.areas.filter(c => c.move === undefined)).toEqual([])
})
