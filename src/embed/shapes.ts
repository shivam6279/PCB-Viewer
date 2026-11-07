import type { Loaded3d } from "../3d/prefetch"
import { modelOutline } from "../3d/model-outline"

// Each part as seen from straight above, in its own frame (centred on its placement, unrotated, a
// bottom-side part turned back face up), in mm: its length and width (length >= width), its height
// above the board, and the convex outline of its bodies. From the 3D models (their projected outline)
// where the board has them, else the bodies' stored outlines. For a host app that finds loose parts
// with a camera: what each part looks like from above, at true size.
export interface PartShape {
	ref: string
	l: number
	w: number
	h: number
	hull: [number, number][]
	fromModel: boolean
}

const MIL = 0.0254 // mm

export function partShapes(loaded: Loaded3d): PartShape[] {
	const { scene, board, models } = loaded
	const bodies = new Map<number, typeof board.bodies>()
	for (const b of board.bodies) if (b.component !== null) bodies.set(b.component, [...(bodies.get(b.component) ?? []), b])
	const out: PartShape[] = []
	for (const [i, bs] of bodies) {
		const c = scene.components[i]
		if (!c?.designator) continue
		const t = (-c.rotation * Math.PI) / 180, ct = Math.cos(t), st = Math.sin(t)
		const pts: [number, number][] = []
		let fromModel = false
		for (const b of bs) {
			const mesh = b.model ? models.get(b.model) : null
			const ring = mesh ? modelOutline(b, mesh) : null
			const rings = ring ? [ring] : b.contour
			fromModel ||= ring !== null
			for (const r of rings)
				for (let k = 0; k + 1 < r.length; k += 2) {
					const dx = r[k]! - c.x, dy = r[k + 1]! - c.y
					let x = dx * ct - dy * st
					const y = dx * st + dy * ct
					if (c.side === "bottom") x = -x // seen from below on the board: turned back face up
					pts.push([x * MIL, y * MIL])
				}
		}
		if (pts.length < 3) continue
		const hull = convexHull(pts)
		const xs = hull.map(p => p[0]), ys = hull.map(p => p[1])
		const ex = Math.max(...xs) - Math.min(...xs), ey = Math.max(...ys) - Math.min(...ys)
		const h = Math.max(...bs.map(b => (b.standoff + b.height) * MIL))
		const round = (v: number) => Math.round(v * 1000) / 1000
		out.push({
			ref: c.designator,
			l: round(Math.max(ex, ey)),
			w: round(Math.min(ex, ey)),
			h: round(h),
			hull: hull.map(([x, y]) => [round(x), round(y)]),
			fromModel,
		})
	}
	return out
}

// Andrew's monotone chain
function convexHull(p: [number, number][]): [number, number][] {
	const s = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1])
	const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
	const lower: [number, number][] = [], upper: [number, number][] = []
	for (const q of s) {
		while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
		lower.push(q)
	}
	for (const q of s.reverse()) {
		while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
		upper.push(q)
	}
	return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}
