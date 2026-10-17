// Solder joints, as triangle meshes in the 3D view's world (mm, z = 0 at the board's top surface):
// solder over the whole of every pad a part is soldered to, rising up the pin or termination. A
// through-hole part's pins and an SMD part's terminations (end caps, gull-wing feet, no-lead
// terminals) are found in the part's own model: whatever of it passes through the hole, or rests on
// the pad.
// The pins are found in the parts' own models, not named: a through-hole pin is whatever of the part
// passes through the plated hole; a chip's termination is the end of the part over its pad.
// Pure apart from three.js maths: no DOM.
import * as THREE from "three"
import type { PcbObject, PcbScene } from "../pcb/scene"
import type { Board3d, Board3dBody } from "./board3d"
import { primPaths, SCALE } from "./board-geometry"
import { bodyMatrix } from "./components"
import { MM, type BoardFrame } from "./frame"
import type { StepMesh } from "./step-mesh"

export interface SolderMesh {
	component: number
	positions: Float32Array
	index: Uint32Array
}

class Builder {
	positions: number[] = []
	index: number[] = []
	vertex(x: number, y: number, z: number) {
		this.positions.push(x, y, z)
		return this.positions.length / 3 - 1
	}
	quad(a: number, b: number, c: number, d: number) {
		this.index.push(a, b, c, a, c, d)
	}
}

export function buildSolder(scene: PcbScene, board: Board3d, models: Map<string, StepMesh | null>, frame: BoardFrame): SolderMesh[] {
	const copper = board.stack.filter(l => l.kind === "copper")
	if (!copper.length) return []
	// The pads' copper faces: the top copper's upper face, the bottom copper's lower face.
	const topZ = -copper[0]!.top * MM
	const bottomZ = -copper[copper.length - 1]!.bottom * MM
	const thickness = frame.thickness
	const toWorld = (x: number, y: number): [number, number] => [(x - frame.cx) * MM, (y - frame.cy) * MM]

	const padsOf = new Map<number, PcbObject[]>()
	for (const o of scene.objects) if (o.kind === "pad" && o.component !== null) padsOf.set(o.component, [...(padsOf.get(o.component) ?? []), o])
	const bodiesOf = new Map<number, Board3dBody[]>()
	for (const b of board.bodies) if (b.component !== null && b.model) bodiesOf.set(b.component, [...(bodiesOf.get(b.component) ?? []), b])

	const out: SolderMesh[] = []
	for (const [component, pads] of padsOf) {
		const bodies = bodiesOf.get(component)
		if (!bodies) continue
		const through = pads.filter(p => !p.pad?.smd && p.pad?.plated && p.holes[0]?.t === "circle")
		// A ball grid's balls are its solder.
		const smd = pads.filter(p => p.pad?.smd)
		const ballGrid = smd.length >= 9 && smd.every(p => p.pad?.shape === "Round")
		const soldered = ballGrid ? [] : smd
		if (!through.length && !soldered.length) continue
		const part = worldPart(bodies, models, frame)
		if (!part.points.length) continue
		const m = new Builder()
		const side = scene.components[component]?.side ?? "top"
		for (const pad of through) throughHoleFillets(m, pad, part.points, toWorld, side, topZ, bottomZ, thickness)
		// A two-terminal chip's joints climb its end caps; an IC's stay about a lead's thickness high.
		const chip = smd.length === 2 && pads.length === 2
		const base = side === "top" ? topZ : bottomZ, dir = side === "top" ? 1 : -1
		const low = soldered.length ? lowTriangles(part, base, dir) : []
		for (const pad of soldered) smdJoint(m, pad, part, low, toWorld, base, dir, chip)
		if (m.index.length) out.push({ component, positions: new Float32Array(m.positions), index: new Uint32Array(m.index) })
	}
	return out
}

// A part's models placed on the board: every vertex (mm, flat x,y,z) and the triangles over them.
interface Part {
	points: number[]
	index: number[]
}

function worldPart(bodies: Board3dBody[], models: Map<string, StepMesh | null>, frame: BoardFrame): Part {
	const points: number[] = []
	const index: number[] = []
	const v = new THREE.Vector3()
	for (const b of bodies) {
		const mesh = b.model ? models.get(b.model) : null
		if (!mesh) continue
		const first = points.length / 3
		const matrix = bodyMatrix(b, frame)
		const p = mesh.positions
		for (let i = 0; i + 2 < p.length; i += 3) {
			v.set(p[i]!, p[i + 1]!, p[i + 2]!).applyMatrix4(matrix)
			points.push(v.x, v.y, v.z)
		}
		for (const k of mesh.index) index.push(first + k)
	}
	return { points, index }
}

// A pad's outline (mm, flat x,y).
function padOutline(pad: PcbObject, toWorld: (x: number, y: number) => [number, number]): number[] {
	const paths: { X: number; Y: number }[][] = []
	for (const p of pad.prims) primPaths(p, paths)
	return paths.flatMap(ring => ring.flatMap(q => toWorld(q.X / SCALE, q.Y / SCALE)))
}

// A through-hole pin's joints: on the far side from the part (where it is soldered), solder over the
// whole pad rising up the pin's protruding end (a low dome over a pin that is flush); on the part's
// side, a thinner joint where the solder wicked through.
function throughHoleFillets(
	m: Builder,
	pad: PcbObject,
	points: number[],
	toWorld: (x: number, y: number) => [number, number],
	side: "top" | "bottom",
	topZ: number,
	bottomZ: number,
	thickness: number,
) {
	const hole = pad.holes[0]!
	if (hole.t !== "circle") return
	const [cx, cy] = toWorld(hole.x, hole.y)
	const holeR = hole.r * MM
	// The pin: the part's geometry inside the hole, below the part's side of the board.
	let pinR = 0, tip = side === "top" ? Infinity : -Infinity, inside = 0
	for (let i = 0; i < points.length; i += 3) {
		const x = points[i]!, y = points[i + 1]!, z = points[i + 2]!
		const d = Math.hypot(x - cx, y - cy)
		if (d > holeR * 1.02) continue
		if (side === "top" ? z > -0.05 : z < -thickness + 0.05) continue
		inside++
		pinR = Math.max(pinR, d)
		tip = side === "top" ? Math.min(tip, z) : Math.max(tip, z)
	}
	if (inside < 2 || pinR < 0.05) return
	const local = { ox: cx, oy: cy, ax: 1, ay: 0 }
	const poly = hull(toLocal(local, padOutline(pad, toWorld)))
	if (poly.length < 3) return
	const term: Termination = { t: "circle", r: pinR }
	const far = side === "top" ? { z: bottomZ, dir: -1 } : { z: topZ, dir: 1 }
	const protrusion = (tip - far.z) * far.dir
	const flush = protrusion <= 0.1
	const height = flush ? 0.15 : Math.min(Math.max(protrusion * 0.7, 0.2), 1.2)
	// A flush pin is covered: the joint domes over it (its middle a plateau at the joint's height).
	joint(m, local, poly, flush ? { t: "circle", r: 0 } : term, [0, 0], () => height, far.z, far.dir)
	const near = side === "top" ? { z: topZ, dir: 1 } : { z: bottomZ, dir: -1 }
	joint(m, local, poly, term, [0, 0], () => 0.18, near.z, near.dir)
}

// An SMD pad's joint: where the part rests on the pad (an end cap, a gull-wing foot, a no-lead
// terminal: whatever of its model lies just over the copper), and solder over the rest of the pad
// rising evenly all round it. The contact is found on a grid over the pad, the model's triangles
// tested within a thin band above the copper.
const BAND = 0.3 // mm above the copper that counts as resting on it
const GRID = 24 // samples across the pad each way
const LEAD = 0.15 // mm: how high an IC's joint climbs (about a lead's thickness)

// The part's triangles that reach down to the copper (most of a model is its body, well above it):
// each as its three corners, x, y and height above the copper.
function lowTriangles(part: Part, base: number, dir: number): number[][] {
	const out: number[][] = []
	const pts = part.points, idx = part.index
	for (let t = 0; t + 2 < idx.length; t += 3) {
		const tri: number[] = []
		for (let k = 0; k < 3; k++) {
			const i = idx[t + k]! * 3
			tri.push(pts[i]!, pts[i + 1]!, (pts[i + 2]! - base) * dir)
		}
		if (Math.min(tri[2]!, tri[5]!, tri[8]!) > BAND || Math.max(tri[2]!, tri[5]!, tri[8]!) < -0.1) continue
		out.push(tri)
	}
	return out
}

function smdJoint(m: Builder, pad: PcbObject, part: Part, low: number[][], toWorld: (x: number, y: number) => [number, number], base: number, dir: number, chip: boolean) {
	const [px, py] = toWorld(pad.at[0], pad.at[1])
	const a = ((pad.pad?.rotation ?? 0) * Math.PI) / 180
	const local: Local = { ox: px, oy: py, ax: Math.cos(a), ay: Math.sin(a) }
	const poly = hull(toLocal(local, padOutline(pad, toWorld)))
	if (poly.length < 3) return
	const s0 = Math.min(...poly.map(p => p[0])), s1 = Math.max(...poly.map(p => p[0]))
	const w0 = Math.min(...poly.map(p => p[1])), w1 = Math.max(...poly.map(p => p[1]))
	const ds = (s1 - s0) / GRID, dw = (w1 - w0) / GRID
	// Which of the grid's samples over the pad the part rests on: each low triangle, taken into the
	// pad's frame, marks the samples under it whose height there lies within the band.
	const covered = new Uint8Array((GRID + 1) * (GRID + 1))
	for (const tri of low) {
		const [as, aw] = toLocal(local, [tri[0]!, tri[1]!]) as [number, number]
		const [bs, bw] = toLocal(local, [tri[3]!, tri[4]!]) as [number, number]
		const [cs, cw] = toLocal(local, [tri[6]!, tri[7]!]) as [number, number]
		const i0 = Math.max(0, Math.ceil((Math.min(as, bs, cs) - s0) / ds)), i1 = Math.min(GRID, Math.floor((Math.max(as, bs, cs) - s0) / ds))
		const j0 = Math.max(0, Math.ceil((Math.min(aw, bw, cw) - w0) / dw)), j1 = Math.min(GRID, Math.floor((Math.max(aw, bw, cw) - w0) / dw))
		if (i0 > i1 || j0 > j1) continue
		const det = (bw - cw) * (as - cs) + (cs - bs) * (aw - cw)
		if (Math.abs(det) < 1e-12) continue
		for (let i = i0; i <= i1; i++)
			for (let j = j0; j <= j1; j++) {
				const k = i * (GRID + 1) + j
				if (covered[k]) continue
				const x = s0 + i * ds, y = w0 + j * dw
				const l1 = ((bw - cw) * (x - cs) + (cs - bs) * (y - cw)) / det
				const l2 = ((cw - aw) * (x - cs) + (as - cs) * (y - cw)) / det
				const l3 = 1 - l1 - l2
				if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue
				const z = l1 * tri[2]! + l2 * tri[5]! + l3 * tri[8]!
				if (z > -0.1 && z < BAND) covered[k] = 1
			}
	}
	// The contact: the covered samples' extent, out to half a cell.
	let cs0 = Infinity, cs1 = -Infinity, cw0 = Infinity, cw1 = -Infinity, count = 0
	for (let i = 0; i <= GRID; i++)
		for (let j = 0; j <= GRID; j++) {
			if (!covered[i * (GRID + 1) + j]) continue
			const sv = s0 + i * ds, wv = w0 + j * dw
			count++
			cs0 = Math.min(cs0, sv - ds / 2)
			cs1 = Math.max(cs1, sv + ds / 2)
			cw0 = Math.min(cw0, wv - dw / 2)
			cw1 = Math.max(cw1, wv + dw / 2)
		}
	if (count < 2) return // nothing of the part rests on this pad
	const term: Termination = { t: "rect", s0: cs0, s1: cs1, w0: cw0, w1: cw1 }
	// A point under the contact and inside the pad, to fan out from.
	const centre: [number, number] = [(Math.max(cs0, s0) + Math.min(cs1, s1)) / 2, (Math.max(cw0, w0) + Math.min(cw1, w1)) / 2]
	// A chip's end cap: up to 40% of the part's height; an IC lead: about its thickness.
	let h = LEAD
	if (chip) {
		let top = 0
		const r = Math.hypot(s1 - s0, w1 - w0)
		for (let i = 0; i + 2 < part.points.length; i += 3)
			if (Math.hypot(part.points[i]! - px, part.points[i + 1]! - py) < r) top = Math.max(top, (part.points[i + 2]! - base) * dir)
		h = Math.min(Math.max(top * 0.4, 0.05), 1)
	}
	joint(m, local, poly, term, centre, () => h, base, dir)
}

// --- the joint's surface -----------------------------------------------------------------------

const RAYS = 96 // around a joint
const STEPS = 10 // from the termination out to the pad's edge
const WETTING = 0.02 // the solder's thickness at the pad's edge (mm): it covers the whole pad

// A frame on the board: origin (ox, oy), its first axis (ax, ay), the second a quarter turn on.
interface Local {
	ox: number
	oy: number
	ax: number
	ay: number
}

function toLocal(l: Local, flat: number[]): number[] {
	const out: number[] = []
	for (let i = 0; i + 1 < flat.length; i += 2) {
		const x = flat[i]! - l.ox, y = flat[i + 1]! - l.oy
		out.push(x * l.ax + y * l.ay, -x * l.ay + y * l.ax)
	}
	return out
}

const fromLocal = (l: Local, s: number, w: number): [number, number] => [l.ox + s * l.ax - w * l.ay, l.oy + s * l.ay + w * l.ax]

// The convex hull of flat points, counter-clockwise (pads are convex, or nearly).
function hull(flat: number[]): [number, number][] {
	const pts: [number, number][] = []
	for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i]!, flat[i + 1]!])
	pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
	if (pts.length < 3) return pts
	const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
	const lower: [number, number][] = [], upper: [number, number][] = []
	for (const p of pts) {
		while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
		lower.push(p)
	}
	for (const p of [...pts].reverse()) {
		while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
		upper.push(p)
	}
	return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

type Termination = { t: "rect"; s0: number; s1: number; w0: number; w1: number } | { t: "circle"; r: number }

// How far a ray from (cx, cy) along (dx, dy) runs before it leaves a convex counter-clockwise polygon.
function exitPolygon(poly: [number, number][], cx: number, cy: number, dx: number, dy: number): number {
	let t = Infinity
	for (let i = 0; i < poly.length; i++) {
		const [px, py] = poly[i]!, [qx, qy] = poly[(i + 1) % poly.length]!
		const nx = qy - py, ny = -(qx - px) // outward
		const along = dx * nx + dy * ny
		if (along > 1e-12) t = Math.min(t, ((px - cx) * nx + (py - cy) * ny) / along)
	}
	return t
}

// How far the same ray runs before it leaves the termination (a circle about the frame's origin).
function exitTermination(term: Termination, cx: number, cy: number, dx: number, dy: number): number {
	if (term.t === "circle") return term.r
	let t = Infinity
	if (dx > 1e-12) t = Math.min(t, (term.s1 - cx) / dx)
	if (dx < -1e-12) t = Math.min(t, (term.s0 - cx) / dx)
	if (dy > 1e-12) t = Math.min(t, (term.w1 - cy) / dy)
	if (dy < -1e-12) t = Math.min(t, (term.w0 - cy) / dy)
	return Math.max(t, 0)
}

// The solder over a pad: along rays from a point under the termination, from where each leaves the
// termination (as high as height(ray) asks) out to the pad's edge (a thin wetting layer), concave in
// between; a skirt down the pad's edge to the copper. Where the termination covers the pad to its
// edge, the ray has nothing to wet. base: the copper's face, dir: +1 up (top side), -1 down.
function joint(m: Builder, l: Local, poly: [number, number][], term: Termination, [cx, cy]: [number, number], height: (dx: number, dy: number) => number, base: number, dir: number) {
	const rings: number[][] = []
	const edge: number[] = []
	for (let k = 0; k < RAYS; k++) {
		const a = (k / RAYS) * Math.PI * 2
		const dx = Math.cos(a), dy = Math.sin(a)
		const outer = exitPolygon(poly, cx, cy, dx, dy)
		const inner = Math.min(exitTermination(term, cx, cy, dx, dy), outer)
		const top = outer - inner > 1e-4 ? Math.max(height(dx, dy), WETTING) : WETTING
		const ray: number[] = []
		for (let j = 0; j <= STEPS; j++) {
			const u = j / STEPS
			const r = inner + (outer - inner) * u
			const [x, y] = fromLocal(l, cx + dx * r, cy + dy * r)
			ray.push(m.vertex(x, y, base + dir * (WETTING + (top - WETTING) * (1 - u) * (1 - u))))
		}
		rings.push(ray)
		const [x, y] = fromLocal(l, cx + dx * outer, cy + dy * outer)
		edge.push(m.vertex(x, y, base))
	}
	for (let k = 0; k < RAYS; k++) {
		const a = rings[k]!, b = rings[(k + 1) % RAYS]!
		for (let j = 0; j < STEPS; j++) m.quad(a[j]!, a[j + 1]!, b[j + 1]!, b[j]!)
		m.quad(a[STEPS]!, edge[k]!, edge[(k + 1) % RAYS]!, b[STEPS]!)
	}
}
