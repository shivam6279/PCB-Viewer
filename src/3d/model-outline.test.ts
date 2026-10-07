import { expect, test } from "vitest"
import type { Board3dBody } from "./board3d"
import { MM } from "./frame"
import { modelOutline } from "./model-outline"
import type { StepMesh } from "./step-mesh"

// A model 2 x 1 x 0.5 mm, centred on its origin in x and y, sitting on z = 0.
const mesh: StepMesh = {
	positions: new Float32Array([-1, -0.5, 0, 1, 0.5, 0.5, 0, 0, 0.25]),
	normals: new Float32Array(9),
	colors: new Uint8Array(12),
	index: new Uint32Array([0, 1, 2]),
}
const body = (o: Partial<Board3dBody>): Board3dBody => ({ component: 0, side: "top", contour: [], standoff: 0, height: 20, color: [0, 0, 0], opacity: 1, model: "m", x: 1000, y: 2000, rx: 0, ry: 0, rz: 0, dz: 0, ...o })

const extentOf = (ring: number[]) => {
	const xs = ring.filter((_, k) => k % 2 === 0), ys = ring.filter((_, k) => k % 2 === 1)
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(v => Math.round(v * 100) / 100)
}

test("a model's outline is its extent, placed at the body's origin (mils)", () => {
	expect(extentOf(modelOutline(body({}), mesh)!)).toEqual([1000 - 1 / MM, 2000 - 0.5 / MM, 1000 + 1 / MM, 2000 + 0.5 / MM].map(v => Math.round(v * 100) / 100))
})

test("turned about z, the outline turns with it; stood up about x, its height becomes its depth", () => {
	expect(extentOf(modelOutline(body({ rz: 90 }), mesh)!)).toEqual([1000 - 0.5 / MM, 2000 - 1 / MM, 1000 + 0.5 / MM, 2000 + 1 / MM].map(v => Math.round(v * 100) / 100))
	// Rx(90): y -> z, z (0..0.5) -> -y (-0.5..0).
	expect(extentOf(modelOutline(body({ rx: 90 }), mesh)!)).toEqual([1000 - 1 / MM, 2000 - 0.5 / MM, 1000 + 1 / MM, 2000].map(v => Math.round(v * 100) / 100))
})

test("on the bottom side the model is turned over: y runs the other way", () => {
	expect(extentOf(modelOutline(body({ side: "bottom", rx: 90 }), mesh)!)).toEqual([1000 - 1 / MM, 2000, 1000 + 1 / MM, 2000 + 0.5 / MM].map(v => Math.round(v * 100) / 100))
})
