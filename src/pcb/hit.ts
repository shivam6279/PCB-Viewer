// What is under a board point: pads and vias first, then tracks/arcs (current layer first, then the
// other visible layers from the top), then the smallest component whose outline holds the point.
// Pure: no DOM.
import { drawOrder } from "./layers"
import type { PcbObject, PcbScene, Prim } from "./scene"

const CELL = 100 // mils

export interface PcbIndex {
	scene: PcbScene
	cells: Map<string, number[]>
}

export function buildIndex(scene: PcbScene): PcbIndex {
	const cells = new Map<string, number[]>()
	for (const o of scene.objects) {
		const [x0, y0, x1, y1] = o.bbox
		if (!Number.isFinite(x0)) continue
		for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
			for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
				const k = `${cx},${cy}`
				const list = cells.get(k)
				if (list) list.push(o.id)
				else cells.set(k, [o.id])
			}
	}
	return { scene, cells }
}

// Objects whose box touches a rectangle (for drawing labels of what is on screen).
export function objectsIn(index: PcbIndex, x0: number, y0: number, x1: number, y1: number): PcbObject[] {
	const seen = new Set<number>()
	const out: PcbObject[] = []
	for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
		for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++)
			for (const id of index.cells.get(`${cx},${cy}`) ?? []) {
				if (seen.has(id)) continue
				seen.add(id)
				const o = index.scene.objects[id]!
				if (o.bbox[2] >= x0 && o.bbox[0] <= x1 && o.bbox[3] >= y0 && o.bbox[1] <= y1) out.push(o)
			}
	return out
}

export type PcbHit = { kind: "object"; id: number } | { kind: "component"; index: number }

export interface HitOptions {
	tolerance: number // mils
	// Whether an object is shown in the current layer view (layer visible, or a via/through-hole pad that
	// passes through the layer shown on its own). Hidden objects are never picked.
	isShown(o: PcbObject): boolean
	current: string
	side: "top" | "bottom"
}

// What a click picks: a pad or via; else the component whose outline holds the point (clicking anywhere
// in a part selects the part, even over a track running under it); else a copper track or arc.
// Only what is shown in the current layer view can be picked, so on Top only, bottom-side parts and
// inner-layer tracks are ignored.
export function hitTest(index: PcbIndex, x: number, y: number, opts: HitOptions): PcbHit | null {
	const { scene } = index
	const candidates = (index.cells.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? [])
		.map(id => scene.objects[id]!)
		.filter(o => opts.isShown(o) && inside(o, x, y, opts.tolerance))
	const order = drawOrder(scene.layers, opts.current, opts.side)
	const depth = (o: PcbObject) => order.indexOf(o.layer) // higher = drawn later = on top
	const topmost = (list: PcbObject[]) => list.sort((a, b) => depth(b) - depth(a))[0]

	const pad = topmost(candidates.filter(o => o.kind === "pad" || o.kind === "via"))
	if (pad) return { kind: "object", id: pad.id }
	const component = componentAt(index, x, y, opts.isShown)
	if (component !== null) return { kind: "component", index: component }
	const track = topmost(candidates.filter(o => o.kind === "track" || o.kind === "arc").filter(o => scene.layers.find(l => l.key === o.layer)?.group === "copper"))
	if (track) return { kind: "object", id: track.id }
	return null
}

// The smallest component whose outline (3D body / pads) holds the point, among those with something shown in the
// current layer view.
export function componentAt(index: PcbIndex, x: number, y: number, isShown: (o: PcbObject) => boolean): number | null {
	const { scene } = index
	let best: { index: number; area: number } | null = null
	for (const [i, c] of scene.components.entries()) {
		const [x0, y0, x1, y1] = c.outline
		if (x < x0 || x > x1 || y < y0 || y > y1) continue
		const area = (x1 - x0) * (y1 - y0)
		if (best && area >= best.area) continue
		if (!c.objects.some(id => { const o = scene.objects[id]!; return o.kind !== "text" && isShown(o) })) continue
		best = { index: i, area }
	}
	return best?.index ?? null
}

function inside(o: PcbObject, x: number, y: number, tol: number): boolean {
	const [x0, y0, x1, y1] = o.bbox
	if (x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol) return false
	return o.prims.some(p => primContains(p, x, y, tol))
}

export function primContains(p: Prim, x: number, y: number, tol: number): boolean {
	switch (p.t) {
		case "circle":
			return Math.hypot(x - p.x, y - p.y) <= p.r + tol
		case "seg":
			return distToSeg(x, y, p.x1, p.y1, p.x2, p.y2) <= p.w / 2 + tol
		case "arc": {
			const d = Math.abs(Math.hypot(x - p.x, y - p.y) - p.r)
			if (d > p.w / 2 + tol) return false
			let a = (Math.atan2(y - p.y, x - p.x) * 180) / Math.PI
			while (a < p.a0) a += 360
			return a <= p.a1 || p.a1 - p.a0 >= 360
		}
		case "poly": {
			let insideCount = 0
			for (const ring of p.rings) if (pointInRing(ring, x, y)) insideCount++
			return insideCount % 2 === 1
		}
		case "text":
			return false
	}
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1, dy = y2 - y1
	const len2 = dx * dx + dy * dy
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function pointInRing(ring: number[], x: number, y: number): boolean {
	let inside = false
	for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
		const xi = ring[i]!, yi = ring[i + 1]!, xj = ring[j]!, yj = ring[j + 1]!
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
	}
	return inside
}
