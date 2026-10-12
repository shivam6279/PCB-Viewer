// What is under a board point: pads and vias first, then the smallest component whose outline holds the
// point, then tracks/arcs (current layer first, then the other visible layers from the top); and the
// whole stack of what is there, for the pick menu and cycling. Pure: no DOM.
import { drawOrder } from "./layers"
import { boxArea, boxContains, type PcbObject, type PcbScene, type PcbSceneComponent, type Prim } from "./scene"

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
	// Whether an object makes its part hoverable and pickable (default: isShown). A through-hole pad is
	// on every copper layer, but it does not put a bottom-side part on Top (see PcbView's rules).
	isPartShown?(o: PcbObject, part: PcbSceneComponent): boolean
	current: string
	side: "top" | "bottom"
	// The part whose pads are open to a click (the selected one, or the one a selected pad is on). When
	// given, the pads of every other part come after their part: a click on one picks the part first.
	// Left out, pads are always picked first (the 3D view).
	openPart?: number | null
}

// What a click picks: a via, a pad on no part or on the open part; else the component whose outline
// holds the point (clicking anywhere in a part selects the part, even over a track running under it, or
// over one of its pads until it is selected); else a copper track or arc.
// Only what is shown in the current layer view can be picked, so on Top only, bottom-side parts and
// inner-layer tracks are ignored.
export function hitTest(index: PcbIndex, x: number, y: number, opts: HitOptions): PcbHit | null {
	const { scene } = index
	return (
		hitsAt(index, x, y, opts).find(h => {
			if (h.kind === "component") return true
			const o = scene.objects[h.id]!
			return o.kind === "pad" || o.kind === "via" || ((o.kind === "track" || o.kind === "arc") && isCopper(scene, o))
		}) ?? null
	)
}

// Everything that can be picked at a point, in the order a click would take it: vias and open pads
// (topmost first), the parts whose outline holds the point (smallest first), the other parts' pads,
// copper tracks and arcs, copper fills
// and regions, polygon pours, then lines and shapes on other layers that belong to no part (a part's own
// silk and outlines are the part). What a part sits on top of is reachable through this list.
export function hitsAt(index: PcbIndex, x: number, y: number, opts: HitOptions): PcbHit[] {
	const { scene } = index
	const candidates = (index.cells.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? [])
		.map(id => scene.objects[id]!)
		.filter(o => o.kind !== "text" && o.kind !== "body" && opts.isShown(o) && inside(o, x, y, opts.tolerance))
	const order = drawOrder(scene.layers, opts.current, opts.side)
	const depth = (o: PcbObject) => order.indexOf(o.layer) // higher = drawn later = on top
	const byDepth = (list: PcbObject[]): PcbHit[] => list.sort((a, b) => depth(b) - depth(a)).map(o => ({ kind: "object", id: o.id }))
	const copper = candidates.filter(o => isCopper(scene, o))
	const pads = candidates.filter(o => o.kind === "pad" || o.kind === "via")
	const open = (o: PcbObject) => opts.openPart === undefined || o.component === null || o.component === opts.openPart

	return [
		...byDepth(pads.filter(open)),
		...componentsAt(index, x, y, opts.isPartShown ?? opts.isShown).map((i): PcbHit => ({ kind: "component", index: i })),
		...byDepth(pads.filter(o => !open(o))),
		...byDepth(copper.filter(o => o.kind === "track" || o.kind === "arc")),
		...byDepth(copper.filter(o => (o.kind === "fill" || o.kind === "region") && !o.pour)),
		...byDepth(copper.filter(o => o.kind === "region" && o.pour)),
		...byDepth(candidates.filter(o => !isCopper(scene, o) && o.component === null && o.kind !== "pad" && o.kind !== "via")),
	]
}

// The net a double-click selects: that of the first thing at the point that has one, looking past parts
// (which have no net) to the copper under them.
export function netAt(index: PcbIndex, x: number, y: number, opts: HitOptions): string | null {
	for (const h of hitsAt(index, x, y, opts)) {
		const net = h.kind === "object" ? index.scene.objects[h.id]!.net : null
		if (net) return net
	}
	return null
}

const isCopper = (scene: PcbScene, o: PcbObject) => scene.layers.find(l => l.key === o.layer)?.group === "copper"

// The smallest component whose outline (3D body / pads) holds the point, among those with something shown in the
// current layer view.
export function componentAt(index: PcbIndex, x: number, y: number, isShown: (o: PcbObject, part: PcbSceneComponent) => boolean): number | null {
	return componentsAt(index, x, y, isShown)[0] ?? null
}

// Every such component, smallest first.
function componentsAt(index: PcbIndex, x: number, y: number, isShown: (o: PcbObject, part: PcbSceneComponent) => boolean): number[] {
	const { scene } = index
	const found: { index: number; area: number }[] = []
	for (const [i, c] of scene.components.entries()) {
		const [x0, y0, x1, y1] = c.outline
		if (x < x0 || x > x1 || y < y0 || y > y1 || !boxContains(c.box, x, y)) continue
		if (!c.objects.some(id => { const o = scene.objects[id]!; return o.kind !== "text" && isShown(o, c) })) continue
		found.push({ index: i, area: boxArea(c.box) })
	}
	return found.sort((a, b) => a.area - b.area).map(f => f.index)
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
