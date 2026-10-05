import * as THREE from "three"
import { expect, test } from "vitest"
import { orbit, pivotOf, type OrbitBoard, type OrbitView } from "./orbit"

const board: OrbitBoard = { centre: new THREE.Vector3(0, 0, -0.8), halfX: 50, halfY: 30 }
const top = new THREE.Quaternion() // looking straight down at the top
const view = (x: number, y: number, distance: number, q = top): OrbitView => ({ offset: new THREE.Vector2(x, y), quaternion: q.clone(), distance })

const near = (a: THREE.Vector3, b: THREE.Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-6)

// Where a world point lands on screen, as a view-plane offset relative to the centre line (0, 0 = middle).
function onScreen(v: OrbitView, p: THREE.Vector3) {
	const cam = board.centre.clone().add(new THREE.Vector3(v.offset.x, v.offset.y, v.distance).applyQuaternion(v.quaternion))
	const local = p.clone().sub(cam).applyQuaternion(v.quaternion.clone().invert())
	return new THREE.Vector2(local.x / -local.z, local.y / -local.z)
}

test("looking down, the pivot is the board mid-plane under the middle of the screen", () => {
	near(pivotOf(view(12, -7, 100), board), new THREE.Vector3(12, -7, -0.8))
})

test("tilted, it is where the centre line crosses the mid-plane", () => {
	const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 4)
	const v = view(0, 0, 100, q)
	const p = pivotOf(v, board)
	expect(p.z).toBeCloseTo(-0.8)
	expect(onScreen(v, p).length()).toBeLessThan(1e-9) // on the centre line
})

test("off the board it is kept within the outline", () => {
	const p = pivotOf(view(500, -400, 100), board)
	near(p, new THREE.Vector3(50, -30, -0.8))
})

test("edge-on (centre line along the board) it is the plane point nearest the board centre", () => {
	const edgeOn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
	const p = pivotOf(view(5, 0, 200, edgeOn), board)
	expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
	expect(p.z).toBeCloseTo(-0.8)
	expect(Math.abs(p.x)).toBeLessThanOrEqual(50)
	expect(Math.abs(p.y)).toBeLessThanOrEqual(30)
})

test("turning about the pivot keeps it in the middle of the screen, at the same distance", () => {
	const v = view(20, 10, 80)
	const pivot = pivotOf(v, board)
	const r = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.7, 0.2))
	const turned = orbit(v, board, pivot, r)
	expect(onScreen(turned, pivot).length()).toBeLessThan(1e-9)
	const cam = (w: OrbitView) => board.centre.clone().add(new THREE.Vector3(w.offset.x, w.offset.y, w.distance).applyQuaternion(w.quaternion))
	expect(cam(turned).distanceTo(pivot)).toBeCloseTo(cam(v).distanceTo(pivot), 9)
})

test("a zero turn changes nothing", () => {
	const v = view(3, 4, 60)
	const t = orbit(v, board, pivotOf(v, board), new THREE.Quaternion())
	expect(t.offset.x).toBeCloseTo(3)
	expect(t.offset.y).toBeCloseTo(4)
	expect(t.distance).toBeCloseTo(60)
})
