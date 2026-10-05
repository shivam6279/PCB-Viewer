// Net labels drawn over the board once zoomed in. Drawn on the live view every frame, so they stay put while zooming and panning.
// Every label in a view is the same size, set by the zoom alone (never per object): 12.5 px up to the
// zoom where a 0.45 mm via is 44 px across, then growing with the 4th root of the zoom (12.5 / 14 /
// 15 / 16 px with a via 40 / 55 / 80 / 118 px across).
// - pad: "number" over "net" on squarish pads, "number : net" along the long side of elongated ones
//   (more than about 2:1), rotated when the pad is taller than wide;
// - via: its net, centred, once the via is ~44 px across;
// - track: its net along each segment wide enough (~14 px), text kept upright.
// Labels never overlap: pads are placed first, then vias, then tracks, and a label that would overlap
// one already placed is dropped. A track label is also dropped where it would sit on a pad or via, which
// carries the same name already.
import type { PcbCamera } from "./draw"
import type { PcbObject } from "./scene"

const FONT_PX = 12.5 // css px
const VIA_MIN = 44 // css px diameter for a via label
// css px per mil at which a standard 17.7 mil (0.45 mm) via is VIA_MIN across: labels start growing here.
const GROW_FROM = VIA_MIN / 17.7165
const TRACK_MIN = 14 // css px width for a track label
const COLOR = "rgba(255,255,255,0.95)"
const DIM = "rgba(255,255,255,0.45)"
const FAMILY = `Roboto, "Segoe UI", Arial, sans-serif`
const GAP = 2 // css px kept between labels

type Box = [number, number, number, number]

interface Label {
	lines: string[]
	x: number
	y: number
	angle: number
	size: number // device px
	box: Box // screen-space bounds, device px
	current: boolean
}

// isCurrent: objects on (or through) the current layer get bright labels; the rest are dimmed.
export function drawLabels(
	ctx: CanvasRenderingContext2D,
	objects: PcbObject[],
	camera: PcbCamera,
	isShown: (o: PcbObject) => boolean,
	isCurrent: (o: PcbObject) => boolean = () => true,
	pixelRatio = globalThis.devicePixelRatio || 1, // device px per css px of the target canvas
) {
	const { width, height } = ctx.canvas
	const dpr = pixelRatio
	const f = camera.flip ? -1 : 1
	const sx = (x: number) => width / 2 + f * (x - camera.cx) * camera.scale
	const sy = (y: number) => height / 2 - (y - camera.cy) * camera.scale
	const px = (mils: number) => (mils * camera.scale) / dpr // a board length in css px
	ctx.setTransform(1, 0, 0, 1, 0, 0)
	const widthAt = (s: string, size: number) => {
		ctx.font = `${size}px ${FAMILY}`
		return ctx.measureText(s).width
	}

	const make = (lines: string[], x: number, y: number, angle: number, size: number, current: boolean): Label => {
		// The rotated text block's screen bounds.
		const w = Math.max(...lines.map(s => widthAt(s, size))) / 2 + GAP * dpr
		const h = (lines.length * size * 1.2) / 2 + GAP * dpr
		const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle))
		const hx = w * c + h * s, hy = w * s + h * c
		return { lines, x, y, angle, size, box: [x - hx, y - hy, x + hx, y + hy], current }
	}
	const hits = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
	const onScreen = (b: Box) => b[2] >= 0 && b[0] <= width && b[3] >= 0 && b[1] <= height

	const pads: Label[] = []
	const vias: Label[] = []
	const tracks: Label[] = []
	const bodies: Box[] = [] // pads and vias on screen, which track labels keep off
	const fontCss = FONT_PX * Math.max(1, camera.scale / dpr / GROW_FROM) ** 0.25
	const font = fontCss * dpr
	const upright = (a: number) => (a > Math.PI / 2 ? a - Math.PI : a < -Math.PI / 2 ? a + Math.PI : a)

	for (const o of objects) {
		if (!isShown(o)) continue
		const current = isCurrent(o)
		if (o.kind === "via" || o.kind === "pad") {
			const b = o.bbox
			bodies.push([Math.min(sx(b[0]), sx(b[2])), sy(b[3]), Math.max(sx(b[0]), sx(b[2])), sy(b[1])])
		}
		if (o.kind === "via") {
			const dia = px(o.width ?? 0)
			if (o.net && dia >= VIA_MIN) vias.push(make([o.net], sx(o.at[0]), sy(o.at[1]), 0, font, current))
		} else if (o.kind === "pad" && o.pad) {
			const number = o.pad.name
			const net = o.net ?? ""
			if (!number && !net) continue
			// The pad's sides on screen: a quarter-turn rotation swaps them.
			const quarter = Math.round(o.pad.rotation / 90) % 2 !== 0
			const w = px(quarter ? o.pad.sizeY : o.pad.sizeX)
			const h = px(quarter ? o.pad.sizeX : o.pad.sizeY)
			const vertical = h > w * 1.15
			const long = Math.max(w, h)
			const short = Math.min(w, h)
			const two = [number, net].filter(Boolean)
			const angle = vertical ? -Math.PI / 2 : 0
			const measure = (s: string) => widthAt(s, font) / dpr
			if (two.length === 2 && long <= short * 2 && short >= fontCss * 2.6 && Math.max(...two.map(measure)) <= long * 1.1)
				pads.push(make(two, sx(o.at[0]), sy(o.at[1]), angle, font, current))
			else {
				const one = two.join(" : ")
				if (short >= fontCss * 1.1 && measure(one) <= long * 1.3) pads.push(make([one], sx(o.at[0]), sy(o.at[1]), angle, font, current))
			}
		} else if (o.kind === "track" && o.net) {
			const p = o.prims[0]
			if (!p || p.t !== "seg" || px(p.w) < TRACK_MIN) continue
			const x1 = sx(p.x1), y1 = sy(p.y1), x2 = sx(p.x2), y2 = sy(p.y2)
			if (widthAt(o.net, font) > Math.hypot(x2 - x1, y2 - y1) * 0.9) continue
			tracks.push(make([o.net], (x1 + x2) / 2, (y1 + y2) / 2, upright(Math.atan2(y2 - y1, x2 - x1)), font, current))
		}
	}

	// Place: pads, then vias, then tracks (which also keep off pad and via copper). Bright labels (current
	// layer) before dim ones, so a label on the layer being looked at wins.
	const placed: Label[] = []
	const free = (l: Label) => onScreen(l.box) && !placed.some(p => hits(p.box, l.box))
	const byCurrent = (list: Label[]) => [...list.filter(l => l.current), ...list.filter(l => !l.current)]
	for (const l of byCurrent(pads)) if (free(l)) placed.push(l)
	for (const l of byCurrent(vias)) if (free(l)) placed.push(l)
	for (const l of byCurrent(tracks)) if (free(l) && !bodies.some(b => hits(b, l.box))) placed.push(l)

	ctx.textAlign = "center"
	ctx.textBaseline = "middle"
	for (const l of placed) {
		ctx.fillStyle = l.current ? COLOR : DIM
		ctx.font = `${l.size}px ${FAMILY}`
		ctx.save()
		ctx.translate(l.x, l.y)
		ctx.rotate(l.angle)
		l.lines.forEach((s, k) => ctx.fillText(s, 0, (k - (l.lines.length - 1) / 2) * l.size * 1.2))
		ctx.restore()
	}
}
