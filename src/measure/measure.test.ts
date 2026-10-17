import { describe, expect, test } from "vitest"
import { buildIndex } from "../pcb/hit"
import type { PcbObject, PcbScene } from "../pcb/scene"
import { dimension, formatMm, measured, nextMode, SNAP_KINDS, type MeasurePoint } from "./measure"
import { circleAt, snapAt } from "./snap"

const pt = (x: number, y: number, z = 0): MeasurePoint => ({ x, y, z, snap: null, on: null })

const object = (o: Partial<PcbObject> & Pick<PcbObject, "id" | "kind" | "prims" | "bbox">): PcbObject => ({
	layer: "TOP",
	net: null,
	component: null,
	holes: [],
	at: [0, 0],
	...o,
})

// A 1000 x 600 mil board: a via at (200, 300), a 10 mil track from (400, 100) to (800, 100).
const scene: PcbScene = {
	origin: [0, 0],
	bounds: [0, 0, 1000, 600],
	outline: [0, 0, 1000, 0, 1000, 600, 0, 600],
	cutouts: [],
	layers: [],
	components: [],
	objects: [
		object({ id: 0, kind: "via", layer: "MULTILAYER", net: "GND", at: [200, 300], prims: [{ t: "circle", x: 200, y: 300, r: 12 }], holes: [{ t: "circle", x: 200, y: 300, r: 6 }], bbox: [188, 288, 212, 312] }),
		object({ id: 1, kind: "track", net: "SIG", at: [600, 100], prims: [{ t: "seg", x1: 400, y1: 100, x2: 800, y2: 100, w: 10 }], bbox: [395, 95, 805, 105] }),
	],
}
const index = buildIndex(scene)
const all = { reach: 15, kinds: new Set(SNAP_KINDS), isShown: () => true }

describe("ruler snapping", () => {
	test("a via snaps to its centre, or to a quadrant point of its rims", () => {
		expect(snapAt(scene, index, 203, 298, all)).toMatchObject({ x: 200, y: 300, kind: "center", on: "Via (GND)" })
		expect(snapAt(scene, index, 212, 302, all)).toMatchObject({ x: 212, y: 300, kind: "vertex" })
	})

	test("zoomed out, a via too small to aim inside offers only its centre", () => {
		expect(snapAt(scene, index, 212, 302, { ...all, pxPerMil: 0.1, reach: 100 })).toMatchObject({ x: 200, y: 300, kind: "center" })
	})

	test("beside a track: its centre line, not its copper edge", () => {
		const s = snapAt(scene, index, 500, 112, all)
		expect(s).toMatchObject({ kind: "edge", on: "Track (SIG)" })
		expect(s!.y).toBeCloseTo(100)
	})

	test("right on a track's copper edge, the edge (its centre line ranks above it otherwise)", () => {
		const s = snapAt(scene, index, 500, 106, all)
		expect(s).toMatchObject({ kind: "edge", target: "track" })
		expect(s!.y).toBeCloseTo(105)
	})

	test("near a track's middle, the midpoint wins over the edge", () => {
		expect(snapAt(scene, index, 603, 104, all)).toMatchObject({ x: 600, y: 100, kind: "midpoint" })
	})

	test("the board outline's corners and sides", () => {
		expect(snapAt(scene, index, 994, 7, all)).toMatchObject({ x: 1000, y: 0, kind: "vertex", on: "Board outline" })
		expect(snapAt(scene, index, 700, 592, all)).toMatchObject({ y: 600, kind: "edge" })
	})

	test("a circle is found by its rim, or by being inside it", () => {
		expect(circleAt(scene, index, 213, 300, all)).toMatchObject({ x: 200, y: 300, r: 12 })
		expect(circleAt(scene, index, 201, 301, { ...all, reach: 2 })).toMatchObject({ x: 200, y: 300, r: 6, on: "Via hole" })
		expect(circleAt(scene, index, 500, 400, all)).toBeNull()
	})

	test("snaps switched off are not taken; nothing in reach: none", () => {
		expect(snapAt(scene, index, 207, 296, { ...all, kinds: new Set(["edge"]) })).toMatchObject({ kind: "edge" })
		expect(snapAt(scene, index, 500, 400, all)).toBeNull()
	})
})

describe("measurements", () => {
	const a = pt(0, 0), b = pt(300, 400, -50)
	test("distance runs through the board; X and Y are spans along one axis", () => {
		expect(measured({ mode: "distance", a, b })).toBeCloseTo(Math.hypot(300, 400, 50))
		expect(measured({ mode: "x", a, b })).toBe(300)
		expect(measured({ mode: "y", a, b })).toBe(400)
	})

	test("unplaced, an axis span runs along a's line, with a leader to b", () => {
		const d = dimension({ mode: "x", a, b, place: null })
		expect(d.dim).toEqual([{ x: 0, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }])
		expect(d.ext).toEqual([[{ x: 300, y: 400, z: -50 }, { x: 300, y: 0, z: 0 }]])
	})

	test("placed: the line moves to the place, joined to both points", () => {
		const flat = { a: pt(0, 0), b: pt(100, 0) }
		const d = dimension({ mode: "distance", ...flat, place: { x: 40, y: -60, z: 0 } })
		expect(d.dim).toEqual([{ x: 0, y: -60, z: 0 }, { x: 100, y: -60, z: 0 }])
		expect(d.ext).toHaveLength(2)
		expect(dimension({ mode: "y", a, b, place: { x: -80, y: 9, z: 0 } }).dim).toEqual([{ x: -80, y: 0, z: 0 }, { x: -80, y: 400, z: 0 }])
	})

	test("a circle: radius or diameter, its line turned toward where it was placed", () => {
		const circle = { a: pt(100, 100), b: pt(130, 100) }
		expect(measured({ mode: "radius", ...circle })).toBeCloseTo(30)
		expect(measured({ mode: "diameter", ...circle })).toBeCloseTo(60)
		const d = dimension({ mode: "diameter", ...circle, place: { x: 100, y: 200, z: 0 } })
		expect(d.dim[0].y).toBeCloseTo(70)
		expect(d.dim[1].y).toBeCloseTo(130)
		expect(d.label).toEqual({ x: 100, y: 200, z: 0 })
	})

	test("Space cycles within its sort; values read in mm", () => {
		expect([nextMode("distance"), nextMode("x"), nextMode("y")]).toEqual(["x", "y", "distance"])
		expect([nextMode("radius"), nextMode("diameter")]).toEqual(["diameter", "radius"])
		expect(formatMm(1000)).toBe("25.400 mm")
		expect(formatMm(5000)).toBe("127.00 mm")
	})
})
