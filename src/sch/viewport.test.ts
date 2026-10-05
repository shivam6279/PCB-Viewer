import { expect, test } from "vitest"
import { fitView, panBy, screenToWorld, zoomAt } from "./viewport"

const container = { width: 1000, height: 500 }

test("fitView centres the content at the container's aspect ratio with a margin", () => {
	const v = fitView({ x: 0, y: 0, w: 100, h: 100 }, container, 0)
	// 100x100 content in a 2:1 container: height limits, width doubles, centred horizontally.
	expect(v).toEqual({ x: -50, y: 0, w: 200, h: 100 })
	const m = fitView({ x: 0, y: 0, w: 200, h: 100 }, container, 0.1)
	expect(m.w / m.h).toBeCloseTo(2)
	expect(m.x + m.w / 2).toBeCloseTo(100)
	expect(m.w).toBeCloseTo(240)
})

test("zoomAt keeps the world point under the cursor fixed", () => {
	const v = { x: 0, y: 0, w: 200, h: 100 }
	const before = screenToWorld(v, container, 250, 400)
	const z = zoomAt(v, 2, 250, 400, container)
	expect(z.w).toBeCloseTo(100)
	const after = screenToWorld(z, container, 250, 400)
	expect(after.x).toBeCloseTo(before.x)
	expect(after.y).toBeCloseTo(before.y)
})

test("zoomAt clamps to the allowed zoom range", () => {
	const v = { x: 0, y: 0, w: 200, h: 100 }
	expect(zoomAt(v, 1e9, 0, 0, container, { minW: 10, maxW: 1000 }).w).toBeCloseTo(10)
	expect(zoomAt(v, 1e-9, 0, 0, container, { minW: 10, maxW: 1000 }).w).toBeCloseTo(1000)
})

test("panBy moves the view opposite to the drag, in world units", () => {
	const v = { x: 0, y: 0, w: 200, h: 100 }
	expect(panBy(v, 500, 250, container)).toEqual({ x: -100, y: -50, w: 200, h: 100 })
})
