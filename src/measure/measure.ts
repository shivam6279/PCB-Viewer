// Measurements made with the ruler, in either board view. Points are in board coordinates, mils (z: 0
// at the board's top face, negative down through it; always 0 in the PCB view). Shown in mm.
//   distance, x, y: two points; the span between them (straight, or along one board axis).
//   radius, diameter: a circle (a hole, via, round pad, arc): its centre and a point on its rim.
// Each is then placed: its dimension line moved off the points (to `place`), joined to them by dashed
// extension lines, so it can sit where it is easy to read.

export type MeasureMode = "distance" | "x" | "y" | "radius" | "diameter"
export const MEASURE_MODES: MeasureMode[] = ["distance", "x", "y", "radius", "diameter"]
export const MODE_LABELS: Record<MeasureMode, string> = { distance: "Distance", x: "X", y: "Y", radius: "Radius", diameter: "Diameter" }
export const MODE_PREFIX: Record<MeasureMode, string> = { distance: "", x: "X ", y: "Y ", radius: "R ", diameter: "Ø " }

export const isCircle = (mode: MeasureMode) => mode === "radius" || mode === "diameter"

export type SnapKind = "vertex" | "center" | "midpoint" | "edge"
export const SNAP_KINDS: SnapKind[] = ["vertex", "center", "midpoint", "edge"]
export const SNAP_LABELS: Record<SnapKind, string> = { vertex: "Vertices", center: "Centres", midpoint: "Midpoints", edge: "Edges" }

export const SNAP_NAMES: Record<SnapKind, string> = { vertex: "Vertex", center: "Centre", midpoint: "Midpoint", edge: "Edge" }

// What a point snapped on: its marker's colour.
export type SnapTarget = "outline" | "pad" | "via" | "hole" | "body" | "track" | "polygon" | "other"
export const TARGET_NAMES: Record<Exclude<SnapTarget, "other">, string> = {
	outline: "Board outline",
	pad: "Pad",
	via: "Via",
	hole: "Hole",
	body: "Part",
	track: "Trace",
	polygon: "Polygon",
}

export interface Vec3 {
	x: number
	y: number
	z: number
}

export interface MeasurePoint extends Vec3 {
	snap: SnapKind | null // what it snapped to (null: where the cursor was)
	on: string | null // the thing it snapped on, for the panel ("Pad U3-4", "Board outline"…)
	target?: SnapTarget | null
}

export interface Measure {
	id: number
	view: "pcb" | "3d"
	mode: MeasureMode
	a: MeasurePoint // the first point; a circle's centre
	b: MeasurePoint // the second point; a point on a circle's rim
	place: Vec3 | null // where its dimension line was put (null: through the points)
	// How tall its text was on the board (mils) at the zoom it was made at: it is never drawn smaller
	// than that on the board, so zoomed in past that it grows with the board.
	minText?: number
}

type Shape = Pick<Measure, "mode" | "a" | "b" | "place">

export const MM = 0.0254

// Space, while placing: the next kind of the same sort (distance -> X -> Y; radius <-> diameter).
export function nextMode(m: MeasureMode): MeasureMode {
	const group: MeasureMode[] = isCircle(m) ? ["radius", "diameter"] : ["distance", "x", "y"]
	return group[(group.indexOf(m) + 1) % group.length]!
}

// A circle measurement's radius (in the board plane).
export const radiusOf = (m: Pick<Measure, "a" | "b">) => Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y)

// The value measured, mils.
export function measured(m: Pick<Measure, "mode" | "a" | "b">): number {
	const dx = m.b.x - m.a.x, dy = m.b.y - m.a.y, dz = m.b.z - m.a.z
	switch (m.mode) {
		case "x":
			return Math.abs(dx)
		case "y":
			return Math.abs(dy)
		case "radius":
			return radiusOf(m)
		case "diameter":
			return 2 * radiusOf(m)
		default:
			return Math.hypot(dx, dy, dz)
	}
}

// mils as mm for a label: three decimals under 100 mm, two above.
export function formatMm(mils: number, unit = true): string {
	const mm = mils * MM
	const text = Math.abs(mm) >= 100 ? mm.toFixed(2) : mm.toFixed(3)
	return unit ? `${text} mm` : text
}

// How a measurement is drawn, in board coordinates: its dimension line (ticked at `ticks`), the dashed
// extension lines from the measured points to it, a dot on each measured point, the circle measured
// (if one), and where its value goes: beside the dimension line's middle, or at `label` itself.
export interface Dimension {
	dim: [Vec3, Vec3]
	ticks: Vec3[]
	// Which way the ticks run (a unit vector): square to the dimension line, in the plane it makes with
	// the measured points (with none, the board's plane), so they keep their place as the view turns.
	tickDir: Vec3
	ext: [Vec3, Vec3][]
	dots: Vec3[]
	ring: { c: Vec3; r: number } | null
	label: Vec3 | null
}

const sub = (p: Vec3, q: Vec3): Vec3 => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z })
const add = (p: Vec3, q: Vec3): Vec3 => ({ x: p.x + q.x, y: p.y + q.y, z: p.z + q.z })
const scale = (p: Vec3, k: number): Vec3 => ({ x: p.x * k, y: p.y * k, z: p.z * k })
const dot = (p: Vec3, q: Vec3) => p.x * q.x + p.y * q.y + p.z * q.z
const at = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z })
const apart = (p: Vec3, q: Vec3) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > 1e-6
const cross = (p: Vec3, q: Vec3): Vec3 => ({ x: p.y * q.z - p.z * q.y, y: p.z * q.x - p.x * q.z, z: p.x * q.y - p.y * q.x })
const unit = (p: Vec3): Vec3 | null => {
	const l = Math.hypot(p.x, p.y, p.z)
	return l > 1e-9 ? scale(p, 1 / l) : null
}

// Square to a line, in the plane it makes with an offset (the way it was moved off its points), else in
// the board's plane (or, for a line standing straight up, across the board's x).
function across(line: Vec3, offset: Vec3 | null): Vec3 {
	const l2 = dot(line, line)
	if (offset && l2 > 1e-12) {
		const t = unit(sub(offset, scale(line, dot(offset, line) / l2)))
		if (t) return t
	}
	return unit(cross(line, { x: 0, y: 0, z: 1 })) ?? unit(cross(line, { x: 1, y: 0, z: 0 })) ?? { x: 0, y: 1, z: 0 }
}

export function dimension(m: Shape): Dimension {
	const { a, b, place } = m
	if (isCircle(m.mode)) {
		const c = at(a)
		const r = radiusOf(m)
		// Its line points at where it was placed (else at the rim point clicked).
		const toward = place ? { x: place.x - c.x, y: place.y - c.y } : { x: b.x - c.x, y: b.y - c.y }
		const len = Math.hypot(toward.x, toward.y) || 1
		const u = { x: toward.x / len, y: toward.y / len }
		const rim = { x: c.x + u.x * r, y: c.y + u.y * r, z: c.z }
		const from = m.mode === "diameter" ? { x: c.x - u.x * r, y: c.y - u.y * r, z: c.z } : c
		const outside = place !== null && Math.hypot(place.x - c.x, place.y - c.y) > r
		return {
			dim: [from, rim],
			ticks: m.mode === "diameter" ? [from, rim] : [rim],
			tickDir: across(sub(rim, from), null),
			ext: outside ? [[rim, { x: place!.x, y: place!.y, z: c.z }]] : [],
			dots: [c],
			ring: { c, r },
			label: outside ? { x: place!.x, y: place!.y, z: c.z } : null,
		}
	}
	let A: Vec3, B: Vec3
	if (m.mode === "x") {
		const y = place ? place.y : a.y, z = place ? place.z : a.z
		A = { x: a.x, y, z }
		B = { x: b.x, y, z }
	} else if (m.mode === "y") {
		const x = place ? place.x : a.x, z = place ? place.z : a.z
		A = { x, y: a.y, z }
		B = { x, y: b.y, z }
	} else if (place) {
		// Parallel to a -> b, moved off it by the part of (place - a) square to it.
		const u = sub(b, a)
		const l2 = dot(u, u)
		const w = sub(place, a)
		const n = l2 > 1e-9 ? sub(w, scale(u, dot(w, u) / l2)) : { x: 0, y: 0, z: 0 }
		A = add(a, n)
		B = add(b, n)
	} else {
		A = at(a)
		B = at(b)
	}
	const ext: [Vec3, Vec3][] = []
	if (apart(a, A)) ext.push([at(a), A])
	if (apart(b, B)) ext.push([at(b), B])
	return { dim: [A, B], ticks: [A, B], tickDir: across(sub(B, A), apart(a, A) ? sub(A, a) : apart(b, B) ? sub(B, b) : null), ext, dots: [at(a), at(b)], ring: null, label: null }
}
