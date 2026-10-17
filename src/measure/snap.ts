// Where a ruler point snaps on the board. A point (tiers 0-2) within reach wins over any edge (tier 3,
// taken only with no point near); among points, a higher tier reaches further and wins over a nearer
// lower one (its distance counts for less):
//   0  centres of pads, vias and holes; part origins; the board origin; the board outline's corners
//      and the centres of its arcs
//   1  a circle's quadrant points (on its x and y axes); the middle of each side of a rectangular pad;
//      track ends
//   2  other corners (polygons, pads); arc ends and middles; track middles; outline side middles
//   3  edges: the nearest point on a track's or arc's centre line, a pad's or polygon's side, a hole's
//      rim, the board outline
//   4  a track's or arc's copper edge (an edge too, reaching less: its centre line comes first)
// And how much an object offers depends on how big it shows (zoomed out, a crowd of small things must
// not each be a snap): under TINY px across only a pad's or via's centre; under SMALL px its centre and
// track ends; bigger, everything. A polygon's corner counts only where its sides show long enough to aim
// at. The board outline always snaps. Board coordinates, mils. Pure: the views pass the reach (a few
// pixels, in mils), the zoom (px per mil) and what is shown.
import type { PcbIndex } from "../pcb/hit"
import { objectsIn } from "../pcb/hit"
import type { ContourSeg, PcbObject, PcbScene, Prim } from "../pcb/scene"
import type { SnapKind, SnapTarget } from "./measure"

export interface Snap {
	x: number
	y: number
	kind: SnapKind
	on: string
	target: SnapTarget
}

export interface SnapOptions {
	reach: number // mils
	kinds: ReadonlySet<SnapKind>
	isShown(o: PcbObject): boolean
	pxPerMil?: number // the zoom (screen px per mil); left out: everything offers everything
}

type Tier = 0 | 1 | 2 | 3 | 4
const REACH: Record<Tier, number> = { 0: 1.6, 1: 1.25, 2: 1, 3: 1, 4: 0.5 } // x the reach
const isEdge = (t: Tier) => t >= 3
const TINY = 6 // px
const SMALL = 24 // px
const CORNER_SIDE = 12 // px: a polygon corner needs a side this long beside it
const SIDE_MIDDLE = 40 // px: a polygon side this long gets its middle
// Points this close count as the same place: the higher tier (else the first found) keeps it (a pad's
// centre over the board outline's corner arc round it).
const SAME = 0.5 // mils

interface Collector {
	px: number // px per mil
	target: SnapTarget // what the points offered now are on
	point(x: number, y: number, kind: SnapKind, on: string, tier: Tier): void
}

function targetOf(o: PcbObject): SnapTarget {
	switch (o.kind) {
		case "pad":
			return "pad"
		case "via":
			return "via"
		case "track":
		case "arc":
			return "track"
		case "region":
		case "fill":
			return "polygon"
		default:
			return "other"
	}
}

export function snapAt(scene: PcbScene, index: PcbIndex, x: number, y: number, opts: SnapOptions): Snap | null {
	const { reach, kinds } = opts
	type Best = Snap & { score: number; tier: Tier }
	let point: Best | null = null, edge: Best | null = null
	const c: Collector = {
		px: opts.pxPerMil ?? Infinity,
		target: "other",
		point(px, py, kind, on, tier) {
			if (!kinds.has(kind)) return
			const score = Math.hypot(px - x, py - y) / (reach * REACH[tier])
			if (score > 1) return
			const best = isEdge(tier) ? edge : point
			if (best) {
				const same = Math.hypot(px - best.x, py - best.y) <= SAME
				if (same ? tier >= best.tier : score >= best.score) return
			}
			const next = { x: px, y: py, kind, on, target: this.target, score, tier }
			if (isEdge(tier)) edge = next
			else point = next
		},
	}
	const far = reach * REACH[0]
	for (const o of objectsIn(index, x - far, y - far, x + far, y + far)) {
		if (o.kind === "text" || o.kind === "body" || !opts.isShown(o)) continue
		const on = describe(scene, o)
		const size = Math.max(o.bbox[2] - o.bbox[0], o.bbox[3] - o.bbox[1]) * c.px
		c.target = targetOf(o)
		if (o.kind === "pad" || o.kind === "via") c.point(o.at[0], o.at[1], "center", on, 0)
		if (size < TINY) continue
		if (size >= SMALL && o.kind === "pad" && o.pad) padSides(c, o, on)
		for (const p of o.prims) prim(c, p, x, y, on, size >= SMALL)
		c.target = o.kind === "via" ? "via" : "hole"
		for (const h of o.holes) prim(c, h, x, y, o.kind === "via" ? "Via hole" : `${on} hole`, size >= SMALL)
	}
	c.target = "body"
	// Part origins, once a part shows big enough to aim inside (and has something shown: on one layer
	// alone, only the parts on it).
	for (const part of scene.components) {
		const [x0, y0, x1, y1] = part.bbox
		if (x < x0 - far || x > x1 + far || y < y0 - far || y > y1 + far) continue
		if (!part.objects.some(id => { const o = scene.objects[id]; return o !== undefined && opts.isShown(o) })) continue
		if (Math.max(x1 - x0, y1 - y0) * c.px >= SMALL) c.point(part.x, part.y, "center", `${part.designator} origin`, 0)
	}
	c.target = "outline"
	c.point(scene.origin[0], scene.origin[1], "center", "Board origin", 0)
	outline(c, scene, x, y)
	const best = (point ?? edge) as Best | null
	return best && { x: best.x, y: best.y, kind: best.kind, on: best.on, target: best.target }
}

export interface Circle {
	x: number
	y: number
	r: number
	on: string
}

// The circle a Radius / Diameter measurement takes at a point: the one whose rim is nearest within
// reach (a hole, via, round pad, arc track's centre line, rounded outline corner), else the smallest
// round hole or pad the point is inside (a click in a hole's middle).
export function circleAt(scene: PcbScene, index: PcbIndex, x: number, y: number, opts: Pick<SnapOptions, "reach" | "isShown">): Circle | null {
	let best: (Circle & { score: number }) | null = null
	const consider = (cx: number, cy: number, r: number, on: string, whole: boolean) => {
		if (!(r > 0)) return
		const d = Math.hypot(x - cx, y - cy)
		const rim = Math.abs(d - r)
		const score = rim <= opts.reach ? rim : whole && d < r ? opts.reach + r : Infinity
		if (score < (best?.score ?? Infinity)) best = { x: cx, y: cy, r, on, score }
	}
	for (const o of objectsIn(index, x - opts.reach, y - opts.reach, x + opts.reach, y + opts.reach)) {
		if (o.kind === "text" || o.kind === "body" || !opts.isShown(o)) continue
		const on = describe(scene, o)
		for (const p of o.prims) {
			if (p.t === "circle") consider(p.x, p.y, p.r, on, true)
			else if (p.t === "arc") consider(p.x, p.y, p.r, on, sweepOf(p.a0, p.a1) >= 360)
		}
		for (const h of o.holes) if (h.t === "circle") consider(h.x, h.y, h.r, o.kind === "via" ? "Via hole" : `${on} hole`, true)
	}
	for (const path of scene.outlinePath ? [scene.outlinePath, ...(scene.cutoutPaths ?? [])] : [])
		for (const s of path) if (s.arc) consider(s.arc.cx, s.arc.cy, s.arc.r, "Board outline", false)
	if (!best) return null
	const { score: _, ...circle } = best as Circle & { score: number }
	return circle
}

function describe(scene: PcbScene, o: PcbObject): string {
	const part = o.component !== null ? scene.components[o.component]?.designator : undefined
	const net = o.net ? ` (${o.net})` : ""
	switch (o.kind) {
		case "pad":
			return `Pad ${part ? `${part}-` : ""}${o.pad?.name ?? ""}${net}`
		case "via":
			return `Via${net}`
		case "track":
			return `Track${net}`
		case "arc":
			return `Arc${net}`
		case "region":
			return o.pour ? `Polygon${net}` : `Region${net}`
		case "fill":
			return `Fill${net}`
		default:
			return o.kind
	}
}

// The nearest point to (x, y) on a segment.
function onSegment(x1: number, y1: number, x2: number, y2: number, x: number, y: number): [number, number] {
	const dx = x2 - x1, dy = y2 - y1
	const l2 = dx * dx + dy * dy
	const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l2))
	return [x1 + t * dx, y1 + t * dy]
}

// (x, y) pushed out from a centre point to a radius: the nearest point on a circle round it.
function outTo(cx: number, cy: number, r: number, x: number, y: number): [number, number] {
	const d = Math.hypot(x - cx, y - cy)
	if (d < 1e-9) return [cx + r, cy]
	return [cx + ((x - cx) / d) * r, cy + ((y - cy) / d) * r]
}

// An arc's sweep from a0 (degrees, counter-clockwise), and whether an angle lies on it.
function sweepOf(a0: number, a1: number) {
	const s = (((a1 - a0) % 360) + 360) % 360
	return s === 0 ? 360 : s
}
const onArc = (a0: number, sweep: number, deg: number) => (((deg - a0) % 360) + 360) % 360 <= sweep

// The nearest point on an arc (centre, radius, degrees) to (x, y).
function nearestOnArc(cx: number, cy: number, r: number, a0: number, a1: number, x: number, y: number): [number, number] {
	const sweep = sweepOf(a0, a1)
	const deg = (Math.atan2(y - cy, x - cx) * 180) / Math.PI
	if (onArc(a0, sweep, deg)) return outTo(cx, cy, r, x, y)
	const at = (a: number): [number, number] => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)]
	const [p, q] = [at(a0), at(a0 + sweep)]
	return Math.hypot(p[0] - x, p[1] - y) <= Math.hypot(q[0] - x, q[1] - y) ? p : q
}

// A pad's own frame: the middle of each side of its box (rectangles, rounded rectangles, octagons,
// oblongs), turned with the pad. A round pad's are its quadrant points (from its circle).
function padSides(c: Collector, o: PcbObject, on: string) {
	const pad = o.pad!
	if (pad.shape === "Custom" || (pad.shape === "Round" && pad.sizeX === pad.sizeY)) return
	const a = (pad.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
	const [cx, cy] = o.at
	for (const [dx, dy] of [[pad.sizeX / 2, 0], [-pad.sizeX / 2, 0], [0, pad.sizeY / 2], [0, -pad.sizeY / 2]] as const)
		c.point(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, "midpoint", on, 1)
}

// What one primitive offers. whole: its object shows big enough for more than its centre and ends.
function prim(c: Collector, p: Prim, x: number, y: number, on: string, whole: boolean) {
	switch (p.t) {
		case "seg": {
			// A track (a round-capped stroke): its ends, its middle, and the nearest point on its centre
			// line (what a track's length and spacing are measured along, not its copper edge).
			c.point(p.x1, p.y1, "center", on, 1)
			c.point(p.x2, p.y2, "center", on, 1)
			if (!whole) return
			c.point((p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2, "midpoint", on, 2)
			const [sx, sy] = onSegment(p.x1, p.y1, p.x2, p.y2, x, y)
			c.point(sx, sy, "edge", on, 3)
			if (p.w > 0) {
				const [ex, ey] = outTo(sx, sy, p.w / 2, x, y)
				c.point(ex, ey, "edge", on, 4)
			}
			return
		}
		case "arc": {
			const sweep = sweepOf(p.a0, p.a1)
			const at = (a: number): [number, number] => [p.x + p.r * Math.cos((a * Math.PI) / 180), p.y + p.r * Math.sin((a * Math.PI) / 180)]
			const [s, e] = [at(p.a0), at(p.a0 + sweep)]
			c.point(s[0], s[1], "vertex", on, 1)
			c.point(e[0], e[1], "vertex", on, 1)
			if (!whole) return
			c.point(p.x, p.y, "center", on, 0)
			const m = at(p.a0 + sweep / 2)
			c.point(m[0], m[1], "midpoint", on, 2)
			quadrants(c, p.x, p.y, p.r, p.a0, sweep, on)
			const [ax, ay] = nearestOnArc(p.x, p.y, p.r, p.a0, p.a1, x, y)
			c.point(ax, ay, "edge", on, 3)
			if (p.w > 0) {
				const [ex, ey] = outTo(ax, ay, p.w / 2, x, y)
				c.point(ex, ey, "edge", on, 4)
			}
			return
		}
		case "circle": {
			c.point(p.x, p.y, "center", on, 0)
			if (!whole) return
			quadrants(c, p.x, p.y, p.r, 0, 360, on)
			const [ex, ey] = outTo(p.x, p.y, p.r, x, y)
			c.point(ex, ey, "edge", on, 3)
			return
		}
		case "poly":
			if (whole) for (const ring of p.rings) ringSnaps(c, ring, x, y, on)
			return
	}
}

// A circle's (or an arc's, those on it) points on its x and y axes.
function quadrants(c: Collector, cx: number, cy: number, r: number, a0: number, sweep: number, on: string) {
	for (const deg of [0, 90, 180, 270]) {
		if (!onArc(a0, sweep, deg)) continue
		const a = (deg * Math.PI) / 180
		c.point(cx + r * Math.cos(a), cy + r * Math.sin(a), "vertex", on, 1)
	}
}

// A closed ring (flat x, y list): its corners (where a side beside them shows long enough to aim at),
// the middles of its longer sides, the nearest point on a side.
function ringSnaps(c: Collector, ring: number[], x: number, y: number, on: string, tier: Tier = 2) {
	const n = Math.floor(ring.length / 2)
	const len = (i: number) => {
		const j = (i + 1) % n
		return Math.hypot(ring[j * 2]! - ring[i * 2]!, ring[j * 2 + 1]! - ring[i * 2 + 1]!)
	}
	for (let i = 0; i < n; i++) {
		const x1 = ring[i * 2]!, y1 = ring[i * 2 + 1]!
		const j = (i + 1) % n
		const x2 = ring[j * 2]!, y2 = ring[j * 2 + 1]!
		const side = len(i)
		if (Math.max(side, len((i - 1 + n) % n)) * c.px >= CORNER_SIDE) c.point(x1, y1, "vertex", on, tier)
		if (side * c.px >= SIDE_MIDDLE && side > 4) c.point((x1 + x2) / 2, (y1 + y2) / 2, "midpoint", on, 2)
		const [ex, ey] = onSegment(x1, y1, x2, y2, x, y)
		c.point(ex, ey, "edge", on, 3)
	}
}

// The board outline and cutouts, with their true arcs where the scene kept them: always offered.
function outline(c: Collector, scene: PcbScene, x: number, y: number) {
	const paths = scene.outlinePath ? [scene.outlinePath, ...(scene.cutoutPaths ?? [])] : null
	if (!paths) {
		const board = { ...c, px: Infinity }
		for (const ring of [scene.outline, ...scene.cutouts]) if (ring.length >= 6) ringSnaps(board, ring, x, y, "Board outline", 0)
		return
	}
	for (const path of paths) contourSnaps(c, path, x, y)
}

function contourSnaps(c: Collector, path: ContourSeg[], x: number, y: number) {
	const on = "Board outline"
	for (let i = 0; i < path.length; i++) {
		const s = path[i]!, e = path[(i + 1) % path.length]!
		c.point(s.x, s.y, "vertex", on, 0)
		if (!s.arc) {
			c.point((s.x + e.x) / 2, (s.y + e.y) / 2, "midpoint", on, 2)
			const [ex, ey] = onSegment(s.x, s.y, e.x, e.y, x, y)
			c.point(ex, ey, "edge", on, 3)
			continue
		}
		const { cx, cy, r, ccw } = s.arc
		c.point(cx, cy, "center", on, 0)
		const deg = (px: number, py: number) => (Math.atan2(py - cy, px - cx) * 180) / Math.PI
		const [a0, a1] = ccw ? [deg(s.x, s.y), deg(e.x, e.y)] : [deg(e.x, e.y), deg(s.x, s.y)]
		const sweep = sweepOf(a0, a1)
		const mid = ((a0 + sweep / 2) * Math.PI) / 180
		c.point(cx + r * Math.cos(mid), cy + r * Math.sin(mid), "midpoint", on, 2)
		quadrants(c, cx, cy, r, a0, sweep, on)
		const [ex, ey] = nearestOnArc(cx, cy, r, a0, a1, x, y)
		c.point(ex, ey, "edge", on, 3)
	}
}
