// Drawing measurements and snap markers on a 2D canvas, in screen space (the views project the board
// points), plus hit tests for clicking a measurement. Sizes are CSS px, scaled by the canvas's pixel ratio.
import { dimension, formatMm, measured, MODE_PREFIX, type Measure, type SnapKind, type SnapTarget, type Vec3 } from "./measure"

export type Pt = { x: number; y: number }

// Board points to the canvas (device px): a point (null when behind the camera), and a segment clipped
// to what is in front of the camera (null when all of it is behind), so a line running past the camera
// still shows its visible part.
export interface Projector {
	point(p: Vec3): Pt | null
	segment(p: Vec3, q: Vec3): [Pt, Pt] | null
	// How long a mil square to the line of sight shows at a point (device px).
	scaleAt(p: Vec3): number
}

// A flat view (the PCB view, at `scale` px per mil): everything is in front, nothing is clipped.
export function flatProjector(project: (p: Vec3) => Pt, scale: number): Projector {
	return { point: project, segment: (p, q) => [project(p), project(q)], scaleAt: () => scale }
}

// A line seen this foreshortened or more (its length on screen against its length square to the view)
// is looked at nearly end-on: its value is not shown, as its turn on screen would swing about wildly.
const END_ON = Math.cos((72 * Math.PI) / 180)

const LINE = "#c9ccd1"
const SELECTED = "#ffffff"
const HALO = "rgba(0, 0, 0, 0.75)"
// The snap marker's colour: what it is on.
export const TARGET_COLOURS: Record<SnapTarget, string> = {
	outline: "#ff9a3c",
	pad: "#ff5ad9",
	via: "#2ee6ff",
	hole: "#b18cff",
	body: "#a6f05a",
	track: "#ffd23f",
	polygon: "#5aa8ff",
	other: "#ffffff",
}

export interface DrawnMeasure {
	id: number
	segments: [Pt, Pt][] // the dimension and extension lines, for hits
	label: { x: number; y: number; w: number; h: number; angle: number } | null // its centre, size and turn (none: hidden)
}

// A measurement keeps its screen size (text TEXT_PX CSS px tall) until the board is zoomed in past
// the zoom it was made at (its minText); from there on all of it grows with the board, so its lines
// don't thin to hairlines beside the copper they measure. One being made keeps its screen size.
export const TEXT_PX = 12

// One measurement (see dimension): dashed extension lines from the measured points to its dimension
// line, the line ticked at its ends, a dot on each measured point, the circle measured, and its value
// in a box running along the line (beside its middle, or beyond where a circle's line was placed),
// always upright.
export function drawMeasure(
	ctx: CanvasRenderingContext2D,
	m: Pick<Measure, "id" | "mode" | "a" | "b" | "place" | "minText">,
	project: Projector,
	ratio: number,
	state: "idle" | "selected" | "live",
): DrawnMeasure | null {
	const d = dimension(m)
	const line = project.segment(d.dim[0], d.dim[1])
	if (!line) return null
	const [A, B] = line
	// How big a mil is on screen at the line's middle (the larger of along it and across it).
	const mid = { x: (d.dim[0].x + d.dim[1].x) / 2, y: (d.dim[0].y + d.dim[1].y) / 2, z: (d.dim[0].z + d.dim[1].z) / 2 }
	const along = { x: d.dim[1].x - d.dim[0].x, y: d.dim[1].y - d.dim[0].y, z: d.dim[1].z - d.dim[0].z }
	const alongLen = Math.hypot(along.x, along.y, along.z) || 1
	const perMil = (dir: { x: number; y: number; z: number }) => {
		const p = project.point(mid), q = project.point({ x: mid.x + dir.x, y: mid.y + dir.y, z: mid.z + dir.z })
		return p && q ? Math.hypot(q.x - p.x, q.y - p.y) : 0
	}
	const milPx = Math.max(perMil(d.tickDir), perMil({ x: along.x / alongLen, y: along.y / alongLen, z: along.z / alongLen }))
	const k = ratio * Math.max(1, m.minText ? (milPx * m.minText) / (TEXT_PX * ratio) : 1)
	const colour = state === "selected" ? SELECTED : LINE
	ctx.save()
	ctx.lineCap = "round"
	ctx.lineJoin = "round"
	const stroke = (pts: Pt[], width: number, dash: number[] = []) => {
		ctx.setLineDash(dash.map(v => v * k))
		ctx.beginPath()
		ctx.moveTo(pts[0]!.x, pts[0]!.y)
		for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y)
		ctx.strokeStyle = HALO
		ctx.lineWidth = (width + 2.5) * k
		ctx.stroke()
		ctx.strokeStyle = colour
		ctx.lineWidth = width * k
		ctx.stroke()
	}
	const segments: [Pt, Pt][] = [[A, B]]
	// The circle measured, traced round (an ellipse when seen at an angle).
	if (d.ring) {
		const ring = d.ring
		const at = (i: number) => {
			const t = (i / 64) * Math.PI * 2
			return { x: ring.c.x + ring.r * Math.cos(t), y: ring.c.y + ring.r * Math.sin(t), z: ring.c.z }
		}
		for (let i = 0; i < 64; i++) {
			const seg = project.segment(at(i), at(i + 1))
			if (seg) stroke(seg, 1, [3, 3])
		}
	}
	for (const [s, e] of d.ext) {
		const seg = project.segment(s, e)
		if (!seg) continue
		stroke(seg, 1, [4, 3])
		segments.push(seg)
	}
	stroke([A, B], state === "selected" ? 2 : 1.5)
	// Ticks at the dimension line's ends: along tickDir (fixed on the board, so they turn with it, not
	// with the view), each about 12 px long on screen (more, zoomed right in).
	for (const t of d.ticks) {
		const p = project.point(t)
		const q = project.point({ x: t.x + d.tickDir.x, y: t.y + d.tickDir.y, z: t.z + d.tickDir.z })
		const perUnit = p && q ? Math.hypot(q.x - p.x, q.y - p.y) : 0
		if (!(perUnit > 1e-6)) continue
		const half = (6 * k) / perUnit
		const tick = project.segment(
			{ x: t.x - d.tickDir.x * half, y: t.y - d.tickDir.y * half, z: t.z - d.tickDir.z * half },
			{ x: t.x + d.tickDir.x * half, y: t.y + d.tickDir.y * half, z: t.z + d.tickDir.z * half },
		)
		if (tick) stroke(tick, 1.5)
	}
	ctx.setLineDash([])
	for (const v of d.dots) {
		const p = project.point(v)
		if (!p) continue
		ctx.beginPath()
		ctx.arc(p.x, p.y, 3 * k, 0, Math.PI * 2)
		ctx.fillStyle = colour
		ctx.strokeStyle = HALO
		ctx.lineWidth = 1.5 * k
		ctx.fill()
		ctx.stroke()
	}
	// The value, turned to run along the line (upright: never upside down); not with the line end-on.
	const square = project.scaleAt(mid)
	const alongPx = perMil({ x: along.x / alongLen, y: along.y / alongLen, z: along.z / alongLen })
	if (square > 0 && alongLen > 1e-6 && alongPx < square * END_ON) {
		ctx.restore()
		return { id: m.id, segments, label: null }
	}
	const text = `${MODE_PREFIX[m.mode]}${formatMm(measured(m))}`
	ctx.font = `600 ${TEXT_PX * k}px system-ui, sans-serif`
	const w = ctx.measureText(text).width + 14 * k, h = 20 * k
	const len = Math.hypot(B.x - A.x, B.y - A.y)
	let angle = len > 1 ? Math.atan2(B.y - A.y, B.x - A.x) : 0
	if (angle > Math.PI / 2) angle -= Math.PI
	else if (angle <= -Math.PI / 2) angle += Math.PI
	const ux = Math.cos(angle), uy = Math.sin(angle) // along the text
	const nx = uy, ny = -ux // up from the text, on screen
	let cx: number, cy: number
	const placed = d.label && project.point(d.label)
	if (placed) {
		// Beyond the place, on the line's way out from the circle.
		const out = Math.sign((placed.x - A.x) * ux + (placed.y - A.y) * uy) || 1
		cx = placed.x + out * ux * (w / 2 + 6 * k)
		cy = placed.y + out * uy * (w / 2 + 6 * k)
	} else {
		// Beside the middle of the line, on its upper side.
		cx = (A.x + B.x) / 2 + nx * (h / 2 + 6 * k)
		cy = (A.y + B.y) / 2 + ny * (h / 2 + 6 * k)
	}
	ctx.translate(cx, cy)
	ctx.rotate(angle)
	ctx.beginPath()
	ctx.roundRect(-w / 2, -h / 2, w, h, 4 * k)
	ctx.fillStyle = "rgba(24, 24, 24, 0.9)"
	ctx.fill()
	ctx.strokeStyle = colour
	ctx.lineWidth = (state === "selected" ? 1.5 : 1) * k
	ctx.stroke()
	ctx.fillStyle = "#fff"
	ctx.textAlign = "center"
	ctx.textBaseline = "middle"
	ctx.fillText(text, 0, 0.5 * k)
	ctx.restore()
	return { id: m.id, segments, label: { x: cx, y: cy, w, h, angle } }
}

// The snap the next click would take: its shape the kind of point (a square on a vertex, a ringed
// cross on a centre, a triangle on a midpoint, a cross on an edge or centre line; a small plain cross
// where nothing is snapped to), its colour what it is on (TARGET_COLOURS); given a note, that beside it
// (the views name what is snapped in the ruler's key instead).
export function drawSnapMarker(ctx: CanvasRenderingContext2D, p: Pt, kind: SnapKind | null, ratio: number, target?: SnapTarget | null, note?: string | null) {
	ctx.save()
	snapShape(ctx, p, kind, 9 * ratio, ratio, kind ? TARGET_COLOURS[target ?? "other"] : "#ffffff")
	if (note) {
		ctx.font = `500 ${11.5 * ratio}px system-ui, sans-serif`
		const w = ctx.measureText(note).width + 12 * ratio, h = 20 * ratio
		const W = ctx.canvas.width, H = ctx.canvas.height
		let x = p.x + 16 * ratio, y = p.y - 16 * ratio - h
		if (x + w > W - 4 * ratio) x = p.x - 16 * ratio - w
		if (y < 4 * ratio) y = p.y + 16 * ratio
		ctx.beginPath()
		ctx.roundRect(x, y, w, h, 4 * ratio)
		ctx.fillStyle = "rgba(20, 20, 20, 0.88)"
		ctx.fill()
		ctx.strokeStyle = kind ? TARGET_COLOURS[target ?? "other"] : "rgba(255, 255, 255, 0.4)"
		ctx.lineWidth = 1 * ratio
		ctx.stroke()
		ctx.fillStyle = "#fff"
		ctx.textBaseline = "middle"
		ctx.fillText(note, x + 6 * ratio, y + h / 2 + 0.5 * ratio)
	}
	ctx.restore()
}

// A marker's shape at p, r its half size, outlined dark so it reads on any copper (also the legend's).
export function snapShape(ctx: CanvasRenderingContext2D, p: Pt, kind: SnapKind | null, r: number, ratio: number, colour: string) {
	const path = () => {
		ctx.beginPath()
		switch (kind) {
			case "vertex":
				ctx.rect(p.x - r, p.y - r, r * 2, r * 2)
				break
			case "center":
				ctx.arc(p.x, p.y, r * 0.75, 0, Math.PI * 2)
				ctx.moveTo(p.x - r * 1.25, p.y)
				ctx.lineTo(p.x + r * 1.25, p.y)
				ctx.moveTo(p.x, p.y - r * 1.25)
				ctx.lineTo(p.x, p.y + r * 1.25)
				break
			case "midpoint":
				ctx.moveTo(p.x, p.y - r)
				ctx.lineTo(p.x + r, p.y + r * 0.8)
				ctx.lineTo(p.x - r, p.y + r * 0.8)
				ctx.closePath()
				break
			case "edge":
				ctx.moveTo(p.x - r * 0.8, p.y - r * 0.8)
				ctx.lineTo(p.x + r * 0.8, p.y + r * 0.8)
				ctx.moveTo(p.x + r * 0.8, p.y - r * 0.8)
				ctx.lineTo(p.x - r * 0.8, p.y + r * 0.8)
				break
			default:
				ctx.moveTo(p.x - r * 0.6, p.y)
				ctx.lineTo(p.x + r * 0.6, p.y)
				ctx.moveTo(p.x, p.y - r * 0.6)
				ctx.lineTo(p.x, p.y + r * 0.6)
		}
	}
	ctx.lineCap = "round"
	path()
	ctx.strokeStyle = HALO
	ctx.lineWidth = 5 * ratio
	ctx.stroke()
	path()
	ctx.strokeStyle = colour
	ctx.lineWidth = 2.2 * ratio
	ctx.stroke()
}

// The measurement under a screen point (its value box, or within a few px of its lines), last drawn first.
export function measureAt(drawn: DrawnMeasure[], p: Pt, ratio: number): number | null {
	const reach = 5 * ratio
	for (let i = drawn.length - 1; i >= 0; i--) {
		const d = drawn[i]!
		// The value's box, turned with its line: the point taken into the box's own frame.
		if (d.label) {
			const { x, y, w, h, angle } = d.label
			const dx = p.x - x, dy = p.y - y
			const along = dx * Math.cos(angle) + dy * Math.sin(angle), across = -dx * Math.sin(angle) + dy * Math.cos(angle)
			if (Math.abs(along) <= w / 2 && Math.abs(across) <= h / 2) return d.id
		}
		for (const [s, e] of d.segments) {
			const dx = e.x - s.x, dy = e.y - s.y
			const l2 = dx * dx + dy * dy
			const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / l2))
			if (Math.hypot(s.x + t * dx - p.x, s.y + t * dy - p.y) <= reach) return d.id
		}
	}
	return null
}
