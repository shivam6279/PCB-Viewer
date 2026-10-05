// Canvas2D PCB renderer. Each layer's shapes are merged into one Path2D (strokes become filled
// capsules, everything wound the same way so a nonzero fill unions them), built once per scene,
// so a frame is one fill per visible layer plus text and holes.
import { drawOrder, type PcbLayer } from "./layers"
import type { PcbObject, PcbScene, Prim } from "./scene"

export interface PcbCamera {
	cx: number // world point at the centre of the canvas (mils)
	cy: number
	scale: number // device pixels per mil
	flip: boolean // bottom-side view: mirrored left-right
}

export interface PcbDrawState {
	camera: PcbCamera
	current: string // current layer key
	visible: Set<string> // visible layer keys
	only: string | null // single-layer mode
	hiddenKinds: Set<string> // object kinds switched off in the Objects tab
	highlight: Set<number> | null // selected object ids: the rest of the board goes grey
	selectedOutline: Set<number> | null // pads drawn with the magenta selection outline
	componentBox: [number, number, number, number] | null
	tone?: string | null // highlighted objects in this colour instead of their layer's (compare: red / green)
}

export const CANVAS_BG = "#c8c8c8"
const BOARD_BG = "#000000"
// Every layer is drawn about 85% opaque over the black board, so a pad on Top reads #d90000 and stacked layers blend (with all
// layers on, a via's silver Multi-Layer copper over red reads pale pink). Holes are translucent too:
// a via hole reads brown on red and olive on green.
const LAYER_ALPHA = 0.85
const PAD_HOLE = "#008b8b"
const VIA_HOLE = "#9b6400"
const SELECT_OUTLINE = "#ff00ff"
const POUR_ALPHA = 0.25
const SELECTED_POUR_ALPHA = POUR_ALPHA // a selected net's pours stay translucent

// A layer's shapes are split into a grid of chunks so a redraw only fills what is in view: filling a
// path costs per shape, wherever it lands, so a whole-layer path made zoomed-in redraws as slow as
// whole-board ones.
interface Chunk {
	bbox: Box
	fill: Path2D
	pour: Path2D // polygon pours, drawn translucent
	texts: Extract<Prim, { t: "text" }>[]
}

interface LayerCache {
	chunks: Chunk[]
	objects: number[]
}

type Box = [number, number, number, number]
const GRID = 12 // chunks per side of the board

export interface PcbRenderCache {
	scene: PcbScene
	layers: Map<string, LayerCache> // per layer, all objects
	byKind: Map<string, Map<string, LayerCache>> // per kind, per layer (when some kinds are hidden)
	holes: { pad: Chunk[]; via: Chunk[] }
	board: Path2D
}

export function buildRenderCache(scene: PcbScene): PcbRenderCache {
	const stackOf = new Map(scene.layers.filter(l => l.group === "copper").map(l => [l.key, l.stack]))
	// The copper layers a via or through-hole pad exists on.
	const spanned = (o: PcbObject) => {
		if (!o.span) return []
		const a = stackOf.get(o.span[0]) ?? 0
		const b = stackOf.get(o.span[1]) ?? Infinity
		return [...stackOf].filter(([, k]) => k >= Math.min(a, b) && k <= Math.max(a, b)).map(([key]) => key)
	}
	// One path per layer: a via's copper is part of every layer it passes through, merged with that
	// layer's tracks and pads so overlaps do not double up under the layer's transparency.
	const [bx0, by0, bx1, by1] = scene.bounds
	const cellOf = (o: PcbObject) => {
		const cx = Math.min(GRID - 1, Math.max(0, Math.floor((((o.bbox[0] + o.bbox[2]) / 2 - bx0) / Math.max(bx1 - bx0, 1)) * GRID)))
		const cy = Math.min(GRID - 1, Math.max(0, Math.floor((((o.bbox[1] + o.bbox[3]) / 2 - by0) / Math.max(by1 - by0, 1)) * GRID)))
		return cy * GRID + cx
	}
	const make = (objects: PcbObject[]) => {
		const out = new Map<string, LayerCache & { cells: Map<number, Chunk> }>()
		for (const o of objects) {
			const cell = cellOf(o)
			for (const key of [o.layer, ...spanned(o)]) {
				let c = out.get(key)
				if (!c) out.set(key, (c = { chunks: [], objects: [], cells: new Map() }))
				c.objects.push(o.id)
				let chunk = c.cells.get(cell)
				if (!chunk) {
					chunk = { bbox: [Infinity, Infinity, -Infinity, -Infinity], fill: new Path2D(), pour: new Path2D(), texts: [] }
					c.cells.set(cell, chunk)
					c.chunks.push(chunk)
				}
				chunk.bbox = grow(chunk.bbox, o.bbox)
				for (const p of o.prims) if (p.t === "text") chunk.texts.push(p)
				else addPrim(o.pour ? chunk.pour : chunk.fill, p)
			}
		}
		return out as Map<string, LayerCache>
	}
	const byKind = new Map<string, Map<string, LayerCache>>()
	for (const kind of new Set(scene.objects.map(o => o.kind))) byKind.set(kind, make(scene.objects.filter(o => o.kind === kind)))
	const holeChunks = (kind: (o: PcbObject) => boolean) => {
		const cells = new Map<number, Chunk>()
		for (const o of scene.objects) {
			if (o.holes.length === 0 || !kind(o)) continue
			const cell = cellOf(o)
			let chunk = cells.get(cell)
			if (!chunk) cells.set(cell, (chunk = { bbox: [Infinity, Infinity, -Infinity, -Infinity], fill: new Path2D(), pour: new Path2D(), texts: [] }))
			chunk.bbox = grow(chunk.bbox, o.bbox)
			for (const h of o.holes) addPrim(chunk.fill, h)
		}
		return [...cells.values()]
	}
	const holes = { pad: holeChunks(o => o.kind !== "via"), via: holeChunks(o => o.kind === "via") }
	const board = new Path2D()
	addRing(board, scene.outline)
	return { scene, layers: make(scene.objects), byKind, holes, board }
}

export function drawPcb(ctx: CanvasRenderingContext2D, cache: PcbRenderCache, state: PcbDrawState) {
	const { canvas } = ctx
	const { camera } = state
	ctx.setTransform(1, 0, 0, 1, 0, 0)
	ctx.filter = "none"
	ctx.fillStyle = CANVAS_BG
	ctx.fillRect(0, 0, canvas.width, canvas.height)
	applyCamera(ctx, camera, canvas.width, canvas.height)

	ctx.fillStyle = BOARD_BG
	ctx.fill(cache.board, "evenodd")

	const view = viewBox(camera, canvas.width, canvas.height)
	const layerOf = new Map(cache.scene.layers.map(l => [l.key, l]))
	const order = drawOrder(cache.scene.layers, state.current, camera.flip ? "bottom" : "top")
	const shown = (key: string) => (state.only ? key === state.only : state.visible.has(key))
	const grey = state.highlight !== null
	if (grey) ctx.filter = "grayscale(1) brightness(1.15)"

	for (const key of order) {
		if (!shown(key)) continue
		const layer = layerOf.get(key)
		if (!layer) continue
		drawLayer(ctx, cache, key, layer, state, view)
	}
	// Holes go through everything: drawn whenever any copper (or the Multi-Layer) is shown.
	if (order.some(k => shown(k) && (k === "MULTILAYER" || layerOf.get(k)?.group === "copper"))) drawHoles(ctx, cache, state.hiddenKinds, view)

	if (grey && state.highlight) {
		ctx.filter = "none"
		drawHighlight(ctx, cache, state, order.filter(shown), layerOf)
	}
	ctx.filter = "none"
}

export function applyCamera(ctx: CanvasRenderingContext2D, camera: PcbCamera, width: number, height: number) {
	const sx = camera.flip ? -camera.scale : camera.scale
	ctx.setTransform(sx, 0, 0, -camera.scale, width / 2 - sx * camera.cx, height / 2 + camera.scale * camera.cy)
}

// The board area a canvas shows, for picking chunks.
function viewBox(camera: PcbCamera, width: number, height: number): Box {
	const hw = width / 2 / camera.scale
	const hh = height / 2 / camera.scale
	return [camera.cx - hw, camera.cy - hh, camera.cx + hw, camera.cy + hh]
}

const overlaps = (a: Box, b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
const grow = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]

function drawLayer(ctx: CanvasRenderingContext2D, cache: PcbRenderCache, key: string, layer: PcbLayer, state: PcbDrawState, view: Box) {
	ctx.fillStyle = layer.color
	const parts: LayerCache[] = []
	if (state.hiddenKinds.size === 0) {
		const c = cache.layers.get(key)
		if (c) parts.push(c)
	} else
		for (const [kind, layers] of cache.byKind) {
			if (state.hiddenKinds.has(kind)) continue
			const c = layers.get(key)
			if (c) parts.push(c)
		}
	const chunks = parts.flatMap(c => c.chunks).filter(c => overlaps(c.bbox, view))
	// Pours first across the whole layer, then the solid copper, so pours never cover tracks.
	ctx.globalAlpha = POUR_ALPHA
	for (const c of chunks) ctx.fill(c.pour)
	ctx.globalAlpha = LAYER_ALPHA
	for (const c of chunks) ctx.fill(c.fill)
	for (const c of chunks) for (const t of c.texts) drawText(ctx, t, layer.color, state.camera.flip)
	ctx.globalAlpha = 1
}

function drawHoles(ctx: CanvasRenderingContext2D, cache: PcbRenderCache, hiddenKinds: Set<string>, view: Box) {
	ctx.globalAlpha = LAYER_ALPHA
	if (!hiddenKinds.has("pad")) {
		ctx.fillStyle = PAD_HOLE
		for (const c of cache.holes.pad) if (overlaps(c.bbox, view)) ctx.fill(c.fill)
	}
	if (!hiddenKinds.has("via")) {
		ctx.fillStyle = VIA_HOLE
		for (const c of cache.holes.via) if (overlaps(c.bbox, view)) ctx.fill(c.fill)
	}
	ctx.globalAlpha = 1
}

function drawHighlight(ctx: CanvasRenderingContext2D, cache: PcbRenderCache, state: PcbDrawState, order: string[], layerOf: Map<string, PcbLayer>) {
	// Only what is on a visible layer: a selected part's hidden 3D-body outline stays hidden.
	const visible = new Set(order)
	const ids = [...state.highlight!]
	// In single-layer mode a selected via or through-hole pad shows in that layer's colour.
	const onlyCopper = state.only !== null && layerOf.get(state.only)?.group === "copper" ? state.only : null
	const layerFor = (o: PcbObject) => (onlyCopper && o.span ? onlyCopper : o.layer)
	const objects = ids
		.map(id => cache.scene.objects[id])
		.filter((o): o is PcbObject => o !== undefined && visible.has(layerFor(o)))
	for (const key of order) {
		const layer = layerOf.get(key)
		if (!layer) continue
		const path = new Path2D()
		const pours = new Path2D()
		const holes = new Path2D()
		const viaHoles = new Path2D()
		let any = false
		for (const o of objects) {
			if (layerFor(o) !== key) continue
			any = true
			for (const p of o.prims) if (p.t === "text") drawText(ctx, p, state.tone ?? layer.color, state.camera.flip)
			else addPrim(o.pour ? pours : path, p)
			for (const h of o.holes) addPrim(o.kind === "via" ? viaHoles : holes, h)
		}
		if (!any) continue
		ctx.fillStyle = state.tone ?? layer.color
		ctx.globalAlpha = SELECTED_POUR_ALPHA
		ctx.fill(pours)
		ctx.globalAlpha = 1
		ctx.fill(path)
		ctx.fillStyle = PAD_HOLE
		ctx.fill(holes)
		ctx.fillStyle = VIA_HOLE
		ctx.fill(viaHoles)
	}
	if (state.componentBox) {
		const [x0, y0, x1, y1] = state.componentBox
		ctx.save()
		ctx.strokeStyle = "#a6a600"
		ctx.lineWidth = 1.5 / state.camera.scale
		ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
		ctx.restore()
	}
	if (state.selectedOutline) {
		ctx.strokeStyle = SELECT_OUTLINE
		ctx.lineWidth = 2 / state.camera.scale
		for (const id of state.selectedOutline) {
			const o = cache.scene.objects[id]
			if (!o || !visible.has(layerFor(o))) continue
			const path = new Path2D()
			for (const p of o.prims) if (p.t !== "text") addPrim(path, p)
			ctx.stroke(path)
		}
	}
}

export function drawText(ctx: CanvasRenderingContext2D, t: Extract<Prim, { t: "text" }>, color: string, flip: boolean) {
	ctx.save()
	ctx.translate(t.x, t.y)
	ctx.rotate((t.rot * Math.PI) / 180)
	// World space is y-up; canvas text is y-down. Mirrored text (bottom side) reads backwards from the
	// top and forwards in the bottom view.
	ctx.scale(t.mirror !== flip ? -1 : 1, -1)
	ctx.fillStyle = color
	ctx.font = `${t.italic ? "italic " : ""}${t.bold ? "bold " : ""}${t.h}px ${JSON.stringify(t.font)}, sans-serif`
	ctx.textBaseline = "alphabetic"
	ctx.fillText(t.text, 0, -t.h * 0.2)
	ctx.restore()
}

// Every shape is added counter-clockwise (in world space) so a nonzero fill unions overlaps.
export function addPrim(path: Path2D, p: Prim) {
	switch (p.t) {
		case "circle":
			path.moveTo(p.x + p.r, p.y)
			path.arc(p.x, p.y, p.r, 0, Math.PI * 2, false)
			break
		case "seg":
			addCapsule(path, p.x1, p.y1, p.x2, p.y2, p.w / 2)
			break
		case "arc":
			addArcStroke(path, p.x, p.y, p.r, (p.a0 * Math.PI) / 180, (p.a1 * Math.PI) / 180, p.w / 2)
			break
		case "poly":
			for (const [k, ring] of p.rings.entries()) addRing(path, ring, k === 0 ? 1 : -1)
			break
		case "text":
			break
	}
}

function addRing(path: Path2D, ring: number[], wantSign = 1) {
	if (ring.length < 6) return
	let area = 0
	for (let k = 0; k < ring.length; k += 2) {
		const j = (k + 2) % ring.length
		area += ring[k]! * ring[j + 1]! - ring[j]! * ring[k + 1]!
	}
	const forward = Math.sign(area) === wantSign || area === 0
	const n = ring.length / 2
	for (let m = 0; m < n; m++) {
		const k = (forward ? m : n - 1 - m) * 2
		if (m === 0) path.moveTo(ring[k]!, ring[k + 1]!)
		else path.lineTo(ring[k]!, ring[k + 1]!)
	}
	path.closePath()
}

function addCapsule(path: Path2D, x1: number, y1: number, x2: number, y2: number, r: number) {
	if (r <= 0) return
	const len = Math.hypot(x2 - x1, y2 - y1)
	if (len < 1e-9) {
		path.moveTo(x1 + r, y1)
		path.arc(x1, y1, r, 0, Math.PI * 2, false)
		return
	}
	const a = Math.atan2(y2 - y1, x2 - x1)
	// Right side forward, round end at p2, left side back, round end at p1: counter-clockwise.
	path.moveTo(x1 + r * Math.sin(a), y1 - r * Math.cos(a))
	path.lineTo(x2 + r * Math.sin(a), y2 - r * Math.cos(a))
	path.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2, false)
	path.lineTo(x1 - r * Math.sin(a), y1 + r * Math.cos(a))
	path.arc(x1, y1, r, a + Math.PI / 2, a + (3 * Math.PI) / 2, false)
	path.closePath()
}

function addArcStroke(path: Path2D, cx: number, cy: number, r: number, a0: number, a1: number, hw: number) {
	if (hw <= 0) return
	const ro = r + hw
	const ri = Math.max(r - hw, 0)
	if (a1 - a0 >= Math.PI * 2 - 1e-6) {
		// Full ring: outer CCW, inner CW.
		path.moveTo(cx + ro, cy)
		path.arc(cx, cy, ro, 0, Math.PI * 2, false)
		if (ri > 0) {
			path.moveTo(cx + ri, cy)
			path.arc(cx, cy, ri, Math.PI * 2, 0, true)
		}
		return
	}
	const end = (a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const
	const [ex, ey] = end(a1)
	const [sx, sy] = end(a0)
	path.moveTo(cx + ro * Math.cos(a0), cy + ro * Math.sin(a0))
	path.arc(cx, cy, ro, a0, a1, false)
	path.arc(ex, ey, hw, a1, a1 + Math.PI, false)
	path.arc(cx, cy, ri, a1, a0, true)
	path.arc(sx, sy, hw, a0 + Math.PI, a0 + Math.PI * 2, false)
	path.closePath()
}

// A component's box on the live view: a selected part gets a green outline with diagonal hatching;
// a hovered one a thin turquoise outline, no fill.
const BOX_COLOR = "#2bb52b"
const HOVER_COLOR = "#3cc8c0"
let hatch: CanvasPattern | null = null
export function drawComponentBox(ctx: CanvasRenderingContext2D, camera: PcbCamera, box: [number, number, number, number], selected: boolean) {
	const { width, height } = ctx.canvas
	const f = camera.flip ? -1 : 1
	const xa = width / 2 + f * (box[0] - camera.cx) * camera.scale
	const xb = width / 2 + f * (box[2] - camera.cx) * camera.scale
	const ya = height / 2 - (box[3] - camera.cy) * camera.scale
	const yb = height / 2 - (box[1] - camera.cy) * camera.scale
	const x = Math.min(xa, xb), y = ya, w = Math.abs(xb - xa), h = yb - ya
	const dpr = globalThis.devicePixelRatio || 1
	ctx.save()
	ctx.setTransform(1, 0, 0, 1, 0, 0)
	if (selected) {
		if (!hatch) {
			const tile = document.createElement("canvas")
			tile.width = tile.height = Math.round(6 * dpr)
			const t = tile.getContext("2d")!
			t.strokeStyle = BOX_COLOR
			t.lineWidth = dpr
			t.beginPath()
			t.moveTo(0, tile.height)
			t.lineTo(tile.width, 0)
			t.stroke()
			hatch = ctx.createPattern(tile, "repeat")
		}
		if (hatch) {
			ctx.globalAlpha = 0.55
			ctx.fillStyle = hatch
			ctx.fillRect(x, y, w, h)
			ctx.globalAlpha = 1
		}
	}
	ctx.strokeStyle = selected ? BOX_COLOR : HOVER_COLOR
	ctx.globalAlpha = 1
	ctx.lineWidth = 2 * dpr
	ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h))
	ctx.restore()
}
