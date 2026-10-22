import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useAppStore } from "../app/store"
import { drawMeasure, drawSnapMarker, flatProjector, measureAt, type DrawnMeasure } from "../measure/draw"
import { MeasureBar, MeasureLegend } from "../measure/MeasureBar"
import { circleAt, snapAt } from "../measure/snap"
import { MeasureTool, measureKey, type ToolHost } from "../measure/tool"
import { usePane, usePaneData, usePaneSelection, type ViewLink } from "../app/pane"
import { whenIdle } from "../app/idle"
import type { Parser } from "../parse/parser"
import { QuarterTurns } from "../app/step-queue"
import { buildRenderCache, CANVAS_BG, cameraMatrix, toBoardPoint, toCanvasPoint, viewExtent, drawArtworkMark, drawComponentBox, drawNetGlow, drawObjectOutline, drawPcb, type PcbCamera, type PcbRenderCache } from "./draw"
import { ARTWORK_DRILLS, ARTWORK_OUTLINE } from "../diff/artwork-keys"
import { drawLabels } from "./labels"
import { buildIndex, componentAt, hitsAt, hitTest, netAt, objectsIn, type HitOptions, type PcbHit, type PcbIndex } from "./hit"
import { LayersPanel } from "./LayersPanel"
import { componentSelection, hitInSelection, hitLabel, hitPosition, hitSelection, netSelection, openPart, pcbHighlight, pcbNetName, selectionSide } from "./selection"
import { PickMenu, type PickRow } from "./PickMenu"
import type { PcbObject, PcbScene, PcbSceneComponent } from "./scene"
import { usePcbScene } from "./use-scene"
import { StackupDialog } from "./StackupDialog"
import { LayerLegend } from "./LayerLegend"
import { cycleCurrent, makeCurrent, nextMode, onlyLayer, type LayerState } from "./layer-state"
import { drawOrder } from "./layers"
import { FlipHorizontal2 } from "lucide-react"

export type { LayerState }

// The view (camera + layer settings) per board, so leaving the PCB tab and coming back shows exactly
// what was there (the component remounts on every tab switch).
const savedViews = new WeakMap<PcbScene, { camera: PcbCamera | null; layers: LayerState }>()

// The last focus request a PCB view acted on (module-level: the view remounts on every tab switch).
let consumedFocus = 0

const CLICK_SLOP = 4
const DIFF_REMOVED = "#ff4d4f"
const DIFF_ADDED = "#3fd06a"
// The offscreen board extends up to half a view beyond each edge, within a pixel budget: drawing cost
// grows with its area, and on a large high-DPI screen a half-view margin made a 48-megapixel bitmap that
// took the GPU 150+ ms per redraw. Past the margin a pan redraws at draft quality anyway.
const BITMAP_MARGIN = 0.5
const BITMAP_BUDGET = 16e6 // pixels
const bitmapMargin = (viewPixels: number) => Math.max(0.05, Math.min(BITMAP_MARGIN, (Math.sqrt(BITMAP_BUDGET / viewPixels) - 1) / 2))
const SETTLE_MS = 120
const REDRAW_EVERY = 150
const TURN_MS = 350 // Q / E: a quarter turn
const DRAFT_QUALITY = 0.5
const HIT_PX = 3 // click tolerance in screen pixels
const CYCLE_NOTE_MS = 1800
const GLOW_TAU = 70 // ms: the Shift-hover net outline's fade time constant (about 95% in 3x this)


export function defaultLayerState(scene: PcbScene): LayerState {
	const visible = new Set<string>()
	for (const l of scene.layers) {
		if (l.key === "KEEPOUT") continue // keep-outs start hidden
		if (l.group !== "mech") visible.add(l.key)
		// Mechanical layers Altium gives a role (courtyard, assembly, 3D body…) or that only carry
		// footprint graphics start hidden.
		else if (scene.objects.some(o => o.layer === l.key && o.component === null) && !/courtyard|assembly|3d body|component center|outline|dimension/i.test(l.name)) visible.add(l.key)
	}
	return { visible, current: "TOP", mode: "all", flip: false, hiddenKinds: new Set() }
}

// Pointer and wheel events over the panels and the legend are theirs, not the board's.
const SNAP_PX = 10 // CSS px: how far the ruler reaches for something to snap to
const inPanel = (e: Event) => (e.target as Element | null)?.closest?.(".pcb-layers, .pcb-legend, .pcb-mirror-badge, .measure-bar") != null

const closeStackup = () => useAppStore.getState().setPcbStackupOpen(false)

export function PcbView({ parser, active = true }: { parser: Parser; active?: boolean }) {
	const pane = usePane()
	const projectData = usePaneData()
	const selection = usePaneSelection()
	const focusSeq = useAppStore(s => s.pcbFocusSeq)
	const mark = pane.mark && !pane.mark.mostly ? pane.mark : null
	// Side by side, both boards show the same place: the camera is shared through the pane's link.
	const link = useRef<ViewLink<{ cx: number; cy: number; scale: number; rot?: number }> | null>(null)
	link.current = (pane.links?.pcb as ViewLink<{ cx: number; cy: number; scale: number; rot?: number }> | undefined) ?? null
	const panelOpen = useAppStore(s => s.pcbPanelOpen)
	const netColorsOn = useAppStore(s => s.netColors.pcb)
	const stackupOpen = useAppStore(s => s.pcbStackupOpen)
	const data = projectData.status === "ready" ? projectData.data : null
	const [layers, setLayers] = useState<LayerState | null>(null)
	// Side by side there is one set of layer controls: the left (primary) board's. The right one follows
	// it, and shows no panel and takes no layer keys of its own.
	const layerLink = (pane.diff ? pane.links?.layers : null) as ViewLink<LayerState> | null | undefined
	const followsLayers = pane.diff && pane.side === "secondary"
	const layersRef = useRef<LayerState | null>(null)
	layersRef.current = layers
	const followsLayersRef = useRef(followsLayers)
	followsLayersRef.current = followsLayers
	const frame = useRef<HTMLDivElement>(null)
	const canvas = useRef<HTMLCanvasElement>(null)
	const camera = useRef<PcbCamera | null>(null)
	const cache = useRef<PcbRenderCache | null>(null)
	const index = useRef<PcbIndex | null>(null)
	const redraw = useRef<(quality?: number) => void>(() => {})
	const rotateRef = useRef<(dir: 1 | -1) => void>(() => {}) // Q / E: a quarter turn, anticlockwise -1
	const canvases = useRef<HTMLCanvasElement[]>([])
	const blit = useRef<() => boolean>(() => false)
	const timing = useRef({ board: 0, blit: 0 }) // ms: last board draw (into the bitmap), last view paint
	const labelRules = useRef<{ isActive(o: PcbObject): boolean; isCurrent(o: PcbObject): boolean } | null>(null)
	const bitmap = useRef<{ canvas: HTMLCanvasElement; camera: PcbCamera; at: number } | null>(null)
	const selectedBox = useRef<number[] | null>(null)
	// A selected pad's part: outlined as when hovered, so the pad shows which part it is on.
	const padPart = useRef<number | null>(null)
	// While Shift is held: the net that was under the cursor when it was pressed stays dark until the
	// mouse moves onto another net (or off copper and back). quiet undefined: not known yet (taken from
	// the first hover); armed: the glow follows the cursor from then on.
	const shiftHover = useRef<{ quiet: string | null | undefined; armed: boolean } | null>(null)
	const hoverComponent = useRef<number | null>(null)
	// The object the pick menu's row under the mouse stands for: outlined on the live view.
	const previewObject = useRef<number | null>(null)
	// Shift-hover: the copper of the net under the cursor on the current layer gets a white outline. Each
	// net has a fade level that eases toward 1 while it is hovered and back to 0 after.
	const glow = useRef({ target: null as string | null, nets: new Map<string, number>(), frame: 0, last: 0 })
	const glowRules = useRef<{ order: string[]; onlyCopper: string | null } | null>(null)
	// Where the last click (or right-click) was, on the board: Shift+Tab steps through what is there.
	const lastClick = useRef<{ x: number; y: number } | null>(null)
	const [menu, setMenu] = useState<{ x: number; y: number; hits: PcbHit[]; nets: string[] } | null>(null)
	const [cycleNote, setCycleNote] = useState<{ at: number; of: number; kind: string; label: string } | null>(null)
	// The ruler: on or off (shared with the 3D view), its measurements, and the one being made here.
	const measuring = useAppStore(s => s.measuring) && active && !pane.diff
	const measuringRef = useRef(measuring)
	measuringRef.current = measuring
	const measures = useAppStore(s => s.measures)
	const drawnMeasures = useRef<DrawnMeasure[]>([])
	const hostRef = useRef<Omit<ToolHost, "redraw" | "scaleAt">>({ point: () => null, circle: () => null, place: () => null })
	const toolRef = useRef<MeasureTool | null>(null)
	toolRef.current ??= new MeasureTool("pcb", {
		point: (x, y, free) => hostRef.current.point(x, y, free),
		circle: (x, y) => hostRef.current.circle(x, y),
		place: (x, y, m) => hostRef.current.place(x, y, m),
		scaleAt: () => (camera.current?.scale ?? 0) / (window.devicePixelRatio || 1),
		redraw: () => blit.current(),
	})
	const tool = toolRef.current

	const load = usePcbScene(parser, data, projectData.status === "error" ? projectData.message : null)
	const scene = load.status === "ready" ? load.scene : null
	// Render caches and default layers follow the scene.
	const [prepared, setPrepared] = useState<PcbScene | null>(null)
	if (scene && prepared !== scene) {
		cache.current = buildRenderCache(scene, data?.netColors)
		index.current = buildIndex(scene)
		setPrepared(scene)
		setLayers((followsLayers ? layerLink?.last?.value : null) ?? savedViews.get(scene)?.layers ?? defaultLayerState(scene))
	}
	// Comparing (deltas only): the board greyed under the differences; else drawn as it is, with the
	// selection (one commit on its own can be selected in).
	const highlight = useMemo(
		() => (mark?.dim ? { objects: new Set<number>(), outline: null, componentBox: null, frame: null } : scene ? pcbHighlight(scene, selection, data?.compiled ?? null) : null),
		[scene, selection, data, mark],
	)
	// Comparing boards: the artwork that differs and the parts moved, added or removed, drawn on the
	// live view: green what this board has and the other not, red what the other has and this not.
	const artwork = mark?.artwork ?? null
	const ringsPath = (rings: number[][]) => {
		const path = new Path2D()
		for (const ring of rings) {
			for (let i = 0; i + 1 < ring.length; i += 2) (i ? path.lineTo : path.moveTo).call(path, ring[i]!, ring[i + 1]!)
			path.closePath()
		}
		return path
	}
	const artPaths = useMemo(() => artwork?.pieces.map(p => ({ layer: p.layer, color: p.tone === "added" ? DIFF_ADDED : DIFF_REMOVED, big: p.big, path: ringsPath(p.rings) })) ?? null, [artwork?.pieces])
	const partPaths = useMemo(() => artwork?.parts.map(p => ({ side: p.side, color: p.tone === "added" ? DIFF_ADDED : DIFF_REMOVED, path: ringsPath([p.box]) })) ?? null, [artwork?.parts])
	const artRef = useRef<Parameters<typeof drawArtworkMark>[2] | null>(null)
	artRef.current = null
	if (artwork && artPaths && partPaths && layers) {
		// A piece shows while its layer does; drill holes with any copper, the board's shape always.
		const only = onlyLayer(layers)
		const isCopper = (key: string) => scene?.layers.find(l => l.key === key)?.group === "copper"
		const shown = (layer: string) =>
			layer === ARTWORK_OUTLINE || (layer === ARTWORK_DRILLS ? (only ? isCopper(only) : true) : only ? layer === only : layers.visible.has(layer))
		// The current layer's differences filled, the other layers' outlined, so they don't bury it.
		const strong = (layer: string) => only !== null || layer === layers.current || layer === ARTWORK_DRILLS || layer === ARTWORK_OUTLINE
		artRef.current = {
			pieces: artPaths.filter(p => shown(p.layer)).map(p => ({ ...p, strong: strong(p.layer) })).sort((x, y) => Number(x.strong) - Number(y.strong)),
			// A part on a side shows while a layer of that side does (in one-layer view: that layer's side).
			moves: artwork.moves.filter(m => m.layers.some(l => (only ? l === only : layers.visible.has(l)))),
			parts: partPaths.filter(p => {
				const sideOf = (key: string) => scene?.layers.find(l => l.key === key)?.side
				return only ? sideOf(only) === p.side : [...layers.visible].some(k => sideOf(k) === p.side)
			}),
			areas: artwork.areas.map(a => a.box),
			focus: artwork.focus?.area ?? null,
		}
	}

	// What the current layer view shows: an object on a visible layer, or (single-layer mode) on that
	// layer or a via/through-hole pad passing through it. Only these are labelled, hovered or picked.
	const rules = useMemo(() => {
		if (!scene || !layers) return null
		const only = onlyLayer(layers)
		const onlyCopper = only !== null && scene.layers.find(l => l.key === only)?.group === "copper"
		const stackOf = new Map(scene.layers.filter(l => l.group === "copper").map(l => [l.key, l.stack]))
		const spans = (o: PcbObject, key: string) => {
			if (!o.span) return false
			const a = stackOf.get(o.span[0]) ?? 0, b = stackOf.get(o.span[1]) ?? Infinity, k = stackOf.get(key) ?? -1
			return k >= Math.min(a, b) && k <= Math.max(a, b)
		}
		const isShown = (o: PcbObject) =>
			!layers.hiddenKinds.has(o.kind) && (only ? o.layer === only || (onlyCopper && spans(o, only)) : layers.visible.has(o.layer))
		const isCurrent = (o: PcbObject) => o.layer === layers.current || spans(o, layers.current)
		// What is labelled, hovered and picked: in highlight mode only what is on the current layer (the
		// rest of the board is greyed out), else everything shown.
		const isActive = layers.mode === "highlight" ? (o: PcbObject) => isShown(o) && isCurrent(o) : isShown
		// Parts live on a side: one is hovered and picked only while the current layer is on its side (its
		// copper, overlay, paste or mask). On an inner or unsided layer no part is, even though through-hole
		// pads pass through it: a bottom-side lens holder held by two such pads is not a part on Mid-Layer 1.
		const currentSide = scene.layers.find(l => l.key === layers.current)?.side
		return {
			isShown,
			isCurrent,
			isActive,
			// The shown layers in draw order, for the net glow.
			order: drawOrder(scene.layers, layers.current, layers.flip ? "bottom" : "top").filter(k => (only ? k === only : layers.visible.has(k))),
			onlyCopper: onlyCopper ? only : null,
			isPartActive: (o: PcbObject, part: PcbSceneComponent) => currentSide === part.side && isActive(o),
		}
	}, [scene, layers])
	labelRules.current = rules
	glowRules.current = rules
	useEffect(() => {
		if (!scene || !layers) return
		const entry = savedViews.get(scene)
		if (entry) entry.layers = layers
		else savedViews.set(scene, { camera: null, layers })
	}, [scene, layers])
	selectedBox.current = highlight?.componentBox ?? null
	const selectedPad = selection?.kind === "pcbObject" && !pane.mark ? scene?.objects[selection.id] : undefined
	padPart.current = selectedPad?.kind === "pad" ? selectedPad.component : null

	// Drawing.
	// Rendering is two-step, so panning and zooming stay smooth: the board is drawn (with labels) into an
	// offscreen bitmap a margin larger than the view; moving the view just redraws that bitmap shifted
	// and scaled, and the board is drawn afresh once the view settles or the bitmap no longer covers it.
	// quality < 1 draws a lower-resolution bitmap: used mid-pan, where it is shown for a moment and
	// rasterising the full-size one would stall a frame; the settle redraw is always full quality.
	redraw.current = (quality = 1) => {
		const el = canvas.current
		const c = cache.current
		const live = camera.current
		const idx = index.current
		if (!el || !c || !live || !layers || !idx) return
		// Mirroring turns the board about its own centre, so it stays where it is on screen.
		if (live.flip !== layers.flip) {
			live.cx = scene!.bounds[0] + scene!.bounds[2] - live.cx
			live.flip = layers.flip
		}
		const cam = { ...live, scale: live.scale * quality }
		const slot = quality < 1 ? 1 : 0
		let off = canvases.current[slot]
		if (!off) off = canvases.current[slot] = document.createElement("canvas")
		const margin = bitmapMargin(el.width * el.height)
		const width = Math.round(el.width * quality * (1 + 2 * margin))
		const height = Math.round(el.height * quality * (1 + 2 * margin))
		if (off.width !== width || off.height !== height) {
			off.width = width
			off.height = height
		}
		const octx = off.getContext("2d")
		if (!octx) return
		const t0 = performance.now()
		drawPcb(octx, c, {
			camera: cam,
			current: layers.current,
			visible: layers.visible,
			only: onlyLayer(layers),
			dimOthers: layers.mode === "highlight",
			hiddenKinds: layers.hiddenKinds,
			highlight: highlight?.objects ?? null,
			selectedOutline: highlight?.outline ?? null,
			componentBox: null, // drawn on the live view (blit) so it stays crisp
			netColors: netColorsOn,
		})
		timing.current.board = performance.now() - t0
		bitmap.current = { canvas: off, camera: { ...cam }, at: performance.now() }
		blit.current()
	}
	// Paints the current view from the bitmap. False when the bitmap leaves part of the view uncovered.
	blit.current = () => {
		const t0 = performance.now()
		try {
			return paint()
		} finally {
			timing.current.blit = performance.now() - t0
		}
	}
	const paint = () => {
		const el = canvas.current
		const cam = camera.current
		const b = bitmap.current
		const ctx = el?.getContext("2d")
		if (!el || !cam || !b || !ctx) return false
		// The bitmap's pixels to the view's: back to the board through the camera it was drawn with, then
		// out through the current one (shifted, scaled and, mid-turn, turned).
		const toBitmap = new DOMMatrix(cameraMatrix(b.camera, b.canvas.width, b.canvas.height)).inverse()
		const bitmapToView = new DOMMatrix(cameraMatrix(cam, el.width, el.height)).multiply(toBitmap)
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.fillStyle = CANVAS_BG
		ctx.fillRect(0, 0, el.width, el.height)
		ctx.imageSmoothingEnabled = true
		ctx.setTransform(bitmapToView)
		ctx.drawImage(b.canvas, 0, 0)
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		const g = glow.current
		if (cache.current && glowRules.current && g.nets.size > 0)
			drawNetGlow(ctx, cache.current, cam, { nets: [...g.nets].map(([net, level]) => ({ net, level })), ...glowRules.current })
		// Labels are drawn on the live view, not into the bitmap, so they stay sharp and sized right
		// while zooming instead of stretching with the bitmap and popping when it settles.
		const idx = index.current
		const rules = labelRules.current
		if (idx && rules) {
			const [x0, y0, x1, y1] = viewExtent(cam, el.width, el.height)
			drawLabels(ctx, objectsIn(idx, x0, y0, x1, y1), cam, rules.isActive, rules.isCurrent)
		}
		const art = artRef.current
		if (art) drawArtworkMark(ctx, cam, art)
		// The selected part's box (green, hatched) and the hovered part's box (outline only).
		const hovered = hoverComponent.current !== null ? scene?.components[hoverComponent.current]?.box : undefined
		if (hovered && hovered !== selectedBox.current) drawComponentBox(ctx, cam, hovered, false)
		if (selectedBox.current) drawComponentBox(ctx, cam, selectedBox.current, true)
		const padBox = padPart.current !== null ? scene?.components[padPart.current]?.box : undefined
		if (padBox && padBox !== hovered) drawComponentBox(ctx, cam, padBox, false)
		const previewed = previewObject.current !== null ? scene?.objects[previewObject.current] : undefined
		if (previewed) drawObjectOutline(ctx, cam, previewed)
		// The ruler's measurements, the one being made, and where the next click would land.
		const toCanvas = (p: { x: number; y: number }) => toCanvasPoint(cam, el.width, el.height, p.x, p.y)
		const project = flatProjector(toCanvas, cam.scale)
		const ratio = window.devicePixelRatio || 1
		const sel = useAppStore.getState().selection
		const drawn: DrawnMeasure[] = []
		for (const m of useAppStore.getState().measures) {
			if (m.view !== "pcb") continue
			const d = drawMeasure(ctx, m, project, ratio, sel?.kind === "measure" && sel.id === m.id ? "selected" : "idle")
			if (d) drawn.push(d)
		}
		drawnMeasures.current = drawn
		if (measuringRef.current) {
			const live = tool.live
			if (live) drawMeasure(ctx, live, project, ratio, "live")
			if (tool.cursor && tool.marking) drawSnapMarker(ctx, toCanvas(tool.cursor), tool.cursor.snap, ratio, tool.cursor.target)
		}
		// Covered when every corner of the view lands inside the bitmap.
		const viewToBitmap = bitmapToView.inverse()
		return [[0, 0], [el.width, 0], [0, el.height], [el.width, el.height]].every(([x, y]) => {
			const p = viewToBitmap.transformPoint(new DOMPoint(x, y))
			return p.x >= 0 && p.y >= 0 && p.x <= b.canvas.width && p.y <= b.canvas.height
		})
	}
	// The part boxes are fitted to the 3D models once those are in (see fitBoxesToModels): repaint the
	// hovered and selected boxes, which are drawn on the live view.
	const modelsIn = useAppStore(s => s.view3dPrepared)
	useEffect(() => {
		if (modelsIn) blit.current()
	}, [modelsIn])
	// Redraw when what is shown changes. While another tab is showing, the redraw waits for idle time
	// (a selection made in SCH or 3D must not stall on this view); it runs at once if the tab comes back
	// first, and coming back with nothing changed draws nothing.
	const drawnFor = useRef<unknown[]>([])
	useEffect(() => {
		const inputs = [layers, highlight, scene, rules, netColorsOn]
		if (inputs.every((v, i) => v === drawnFor.current[i])) return
		const draw = () => {
			drawnFor.current = inputs
			redraw.current()
		}
		if (active) return draw()
		return whenIdle(draw)
	}, [layers, highlight, scene, rules, netColorsOn, active])

	// Size, fit and interaction once the scene is ready.
	useEffect(() => {
		const el = canvas.current
		const fr = frame.current
		if (!scene || !el || !fr) return
		const dpr = () => window.devicePixelRatio || 1
		// A hidden view (another tab is showing) has no size: keep the last one until it shows again.
		const resize = () => {
			if (fr.clientWidth === 0 || fr.clientHeight === 0) return
			el.width = Math.max(1, Math.round(fr.clientWidth * dpr()))
			el.height = Math.max(1, Math.round(fr.clientHeight * dpr()))
			el.style.width = `${fr.clientWidth}px`
			el.style.height = `${fr.clientHeight}px`
		}
		const fitTo = (b: [number, number, number, number], margin: number, minWidth = 0) => {
			resize() // the view may just have been shown: frame for its real size
			const w = Math.max(b[2] - b[0], minWidth), h = Math.max(b[3] - b[1], minWidth * 0.6)
			const scale = Math.min(el.width / (w * (1 + 2 * margin)), el.height / (h * (1 + 2 * margin)))
			camera.current = { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, scale, flip: camera.current?.flip ?? false, rot: camera.current?.rot ?? 0 }
		}
		resize()
		const saved = savedViews.get(scene)?.camera
		if (saved) camera.current = { ...saved }
		else fitTo(scene.bounds, 0.04)
		const me = {}
		const shared = link.current
		if (shared?.last) camera.current = { ...camera.current!, ...shared.last.value }
		redraw.current()
		fitRef.current = (b, min) => {
			fitTo(b, 0.25, min)
			redraw.current()
			// Side by side, the other board goes there too.
			const cam = camera.current!
			shared?.publish({ cx: cam.cx, cy: cam.cy, scale: cam.scale, rot: cam.rot ?? 0 }, me)
		}

		let frameReq = 0
		// While the view moves: shift/scale the bitmap every frame, redraw the board when it settles, or
		// sooner when the bitmap no longer covers the view (at most every REDRAW_EVERY ms).
		let settle = 0
		const schedule = (publish = true) => {
			const cam = camera.current
			if (publish && cam) shared?.publish({ cx: cam.cx, cy: cam.cy, scale: cam.scale, rot: cam.rot ?? 0 }, me)
			if (!frameReq)
				frameReq = requestAnimationFrame(() => {
					frameReq = 0
					const covered = blit.current()
					if (!covered && performance.now() - (bitmap.current?.at ?? 0) > REDRAW_EVERY) redraw.current(DRAFT_QUALITY)
				})
			clearTimeout(settle)
			settle = window.setTimeout(() => redraw.current(), SETTLE_MS)
		}
		const toWorld = (clientX: number, clientY: number) => {
			const r = el.getBoundingClientRect()
			const cam = camera.current!
			return toBoardPoint(cam, el.width, el.height, (clientX - r.left) * dpr(), (clientY - r.top) * dpr())
		}
		// Q / E: a quarter turn anticlockwise / clockwise about the middle of the view. Presses queue (see
		// step-queue.ts): the view keeps turning while any are waiting and comes to rest square.
		const quarters = new QuarterTurns<"z">()
		let turnFrame = 0
		const runQuarters = () => {
			const cam = camera.current
			if (!cam || !quarters.begin()) return
			const from = cam.rot ?? 0
			let last = performance.now()
			const step = () => {
				const now = performance.now()
				const { quarters: turned, ended } = quarters.advance(Math.min((now - last) / 1000, 0.05))
				last = now
				const c = camera.current!
				c.rot = from + (turned * Math.PI) / 2
				if (ended) {
					turnFrame = 0
					const quarter = Math.PI / 2
					c.rot = (((Math.round(c.rot / quarter) % 4) + 4) % 4) * quarter // exactly square, within one turn
				} else turnFrame = requestAnimationFrame(step)
				schedule()
			}
			turnFrame = requestAnimationFrame(step)
		}
		rotateRef.current = dir => {
			quarters.push({ key: "z", dir })
			if (!turnFrame) runQuarters()
		}

		// For the browser tests: the scene, and where a board point is on screen.
		Object.assign(el, {
			__pcb: {
				scene,
				toClient(x: number, y: number) {
					const r = el.getBoundingClientRect()
					const p = toCanvasPoint(camera.current!, el.width, el.height, x, y)
					return { x: r.left + p.x / dpr(), y: r.top + p.y / dpr() }
				},
				camera: () => ({ ...camera.current! }),
				layers: () => layersRef.current,
				timing: () => ({ ...timing.current }),
				hover: () => hoverComponent.current,
				padPart: () => padPart.current,
				glow: () => ({ target: glow.current.target, nets: Object.fromEntries(glow.current.nets) }),
				ruler: () => ({ first: tool.first, picked: tool.picked }),
				pick: (x: number, y: number) => pickRef.current({ x, y }),
				hits: (x: number, y: number) => stackRef.current({ x, y }),
				view(cx: number, cy: number, scale: number) {
					camera.current = { ...camera.current!, cx, cy, scale }
					redraw.current()
				},
			},
		})
		// Ctrl+Shift+wheel steps the current layer through the visible ones: one step per notch (a
		// trackpad's stream of small deltas adds up to a notch first).
		let layerWheel = 0
		const onWheel = (e: WheelEvent) => {
			if (inPanel(e)) return
			e.preventDefault()
			if (e.ctrlKey && e.shiftKey) {
				if (followsLayersRef.current) return
				const delta = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1)
				layerWheel += delta
				if (Math.abs(layerWheel) < 40) return
				const dir = layerWheel > 0 ? -1 : 1 // wheel up: the next layer down the list
				layerWheel = 0
				setLayers(prev => (prev ? cycleCurrent(prev, scene, dir) : prev))
				return
			}
			const cam = camera.current!
			const before = toWorld(e.clientX, e.clientY)
			const fit = Math.min(el.width / (scene.bounds[2] - scene.bounds[0]), el.height / (scene.bounds[3] - scene.bounds[1]))
			cam.scale = Math.min(fit * 400, Math.max(fit / 4, cam.scale * Math.exp(-e.deltaY * 0.0015)))
			const after = toWorld(e.clientX, e.clientY)
			cam.cx += before.x - after.x
			cam.cy += before.y - after.y
			schedule()
		}
		let drag: { x: number; y: number; sx: number; sy: number; moved: boolean; button: number } | null = null
		const onDown = (e: PointerEvent) => {
			if (inPanel(e)) return
			drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, button: e.button }
			fr.setPointerCapture?.(e.pointerId)
		}
		// Where the pointer is over the board (null off it): Shift pressed or released without moving
		// hovers there.
		let pointer: { x: number; y: number } | null = null
		const onMove = (e: PointerEvent) => {
			if (!drag && measuringRef.current) {
				pointer = inPanel(e) ? null : { x: e.clientX, y: e.clientY }
				if (pointer) tool.move(e.clientX, e.clientY, e.ctrlKey)
				else tool.leave()
				return
			}
			if (!drag) {
				pointer = inPanel(e) ? null : { x: e.clientX, y: e.clientY }
				hoverRef.current(pointer && toWorld(pointer.x, pointer.y), e.shiftKey)
				return
			}
			if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < CLICK_SLOP) return
			if (!drag.moved) fr.classList.add("panning")
			drag.moved = true
			// The board follows the mouse: the move taken back to the board, whatever the turn.
			const cam = camera.current!
			const before = toBoardPoint(cam, el.width, el.height, drag.x * dpr(), drag.y * dpr())
			const after = toBoardPoint(cam, el.width, el.height, e.clientX * dpr(), e.clientY * dpr())
			cam.cx -= after.x - before.x
			cam.cy -= after.y - before.y
			drag.x = e.clientX
			drag.y = e.clientY
			schedule()
		}
		// A right-button drag pans; the menu its release would open is not wanted.
		let pannedRight = false
		const onUp = (e: PointerEvent) => {
			const click = drag !== null && !drag.moved && drag.button === 0 && e.type === "pointerup"
			pannedRight = drag !== null && drag.moved && drag.button === 2
			drag = null
			fr.classList.remove("panning")
			if (click && measuringRef.current) tool.click(e.clientX, e.clientY, e.ctrlKey)
			else if (click) clickRef.current(toWorld(e.clientX, e.clientY), devicePoint(e.clientX, e.clientY))
		}
		// A client point in the canvas's device pixels (where measurements are drawn and hit).
		const devicePoint = (clientX: number, clientY: number) => {
			const r = el.getBoundingClientRect()
			return { x: (clientX - r.left) * dpr(), y: (clientY - r.top) * dpr() }
		}
		// Double-click on anything with a net selects and highlights the whole net.
		const onDouble = (e: MouseEvent) => {
			if (inPanel(e) || measuringRef.current) return
			doubleRef.current(toWorld(e.clientX, e.clientY))
		}
		const onLeave = () => {
			pointer = null
			if (measuringRef.current) tool.leave()
			// Coming back onto the board onto any net, the same one included, is moving onto it.
			if (shiftHover.current) shiftHover.current.quiet = null
			hoverRef.current(null, false)
		}
		// Pressing Shift glows nothing by itself: only moving onto a net afterwards does (see shiftHover).
		const onShift = (e: KeyboardEvent) => {
			// Ctrl turns the ruler's snapping off while held: the marker follows at once.
			if (e.key === "Control" && !e.repeat && measuringRef.current) return tool.refresh(e.type === "keydown")
			if (e.key !== "Shift" || e.repeat) return
			const down = e.type === "keydown"
			shiftHover.current = down ? { quiet: pointer ? undefined : null, armed: false } : null
			hoverRef.current(pointer && !drag ? toWorld(pointer.x, pointer.y) : null, down)
		}
		const onBlur = () => {
			shiftHover.current = null
			hoverRef.current(pointer && toWorld(pointer.x, pointer.y), false)
		}
		window.addEventListener("keydown", onShift)
		window.addEventListener("keyup", onShift)
		window.addEventListener("blur", onBlur)
		// Right-click lists everything under the cursor (no browser menu over the board).
		const onMenu = (e: MouseEvent) => {
			e.preventDefault()
			if (inPanel(e) || pannedRight) return void (pannedRight = false)
			drag = null
			menuRef.current(e.clientX, e.clientY, toWorld(e.clientX, e.clientY))
		}
		fr.addEventListener("contextmenu", onMenu)
		const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => (resize(), redraw.current()))
		fr.addEventListener("wheel", onWheel, { passive: false })
		fr.addEventListener("pointerdown", onDown)
		fr.addEventListener("pointermove", onMove)
		fr.addEventListener("pointerup", onUp)
		fr.addEventListener("pointercancel", onUp)
		fr.addEventListener("dblclick", onDouble)
		fr.addEventListener("pointerleave", onLeave)
		ro?.observe(fr)
		const unlink = shared?.subscribe((v, from) => {
			if (from === me || !camera.current) return
			camera.current = { ...camera.current, ...v }
			schedule(false)
		})
		return () => {
			const entry = savedViews.get(scene)
			if (entry && camera.current) entry.camera = { ...camera.current }
			cancelAnimationFrame(frameReq)
			cancelAnimationFrame(turnFrame)
			clearTimeout(settle)
			unlink?.()
			fr.removeEventListener("wheel", onWheel)
			fr.removeEventListener("pointerdown", onDown)
			fr.removeEventListener("pointermove", onMove)
			fr.removeEventListener("pointerup", onUp)
			fr.removeEventListener("pointercancel", onUp)
			fr.removeEventListener("dblclick", onDouble)
			fr.removeEventListener("pointerleave", onLeave)
			fr.removeEventListener("contextmenu", onMenu)
			window.removeEventListener("keydown", onShift)
			window.removeEventListener("keyup", onShift)
			window.removeEventListener("blur", onBlur)
			cancelAnimationFrame(glow.current.frame)
			glow.current.frame = 0
			ro?.disconnect()
		}
	}, [scene])

	const fitRef = useRef<(b: [number, number, number, number], minWidth: number) => void>(() => {})
	const clickRef = useRef<(p: { x: number; y: number }, device: { x: number; y: number }) => void>(() => {})
	const hitOptions = (): HitOptions | null => {
		const cam = camera.current
		if (!cam || !layers || !rules) return null
		return {
			tolerance: (HIT_PX * (window.devicePixelRatio || 1)) / cam.scale,
			isShown: rules.isActive,
			isPartShown: rules.isPartActive,
			current: layers.current,
			side: layers.flip ? "bottom" : "top",
			// A part's pads are reached by selecting the part first.
			openPart: scene ? openPart(scene, selection, data?.compiled ?? null) : null,
		}
	}
	const pick = (p: { x: number; y: number }) => {
		const idx = index.current
		const opts = hitOptions()
		return scene && idx && opts ? hitTest(idx, p.x, p.y, opts) : null
	}
	// Everything under a point, in pick order (see hitsAt).
	const stackAt = (p: { x: number; y: number }) => {
		const idx = index.current
		const opts = hitOptions()
		return scene && idx && opts ? hitsAt(idx, p.x, p.y, opts) : []
	}
	const pickRef = useRef<(p: { x: number; y: number }) => ReturnType<typeof pick>>(() => null)
	pickRef.current = pick
	const stackRef = useRef<(p: { x: number; y: number }) => PcbHit[]>(() => [])
	stackRef.current = stackAt
	clickRef.current = (p, device) => {
		const { select } = useAppStore.getState()
		lastClick.current = p
		setCycleNote(null)
		// A measurement is picked over the board under it.
		const measure = measureAt(drawnMeasures.current, device, window.devicePixelRatio || 1)
		if (measure !== null) return select({ kind: "measure", id: measure })
		const hit = pick(p)
		if (!scene || !hit) return select(null)
		// With something selected, a click outside it only clears the selection (and brings hover back).
		if (selection && !hitInSelection(scene, hit, selection, data?.compiled ?? null)) return select(null)
		if (hit.kind === "object") return select({ kind: "pcbObject", id: hit.id })
		select(componentSelection(scene, hit.index, data?.compiled ?? null))
	}
	const doubleRef = useRef<(p: { x: number; y: number }) => void>(() => {})
	// Double-click selects the net under the cursor, looking past a part to the copper it covers.
	doubleRef.current = p => {
		const idx = index.current
		const opts = hitOptions()
		const net = idx && opts ? netAt(idx, p.x, p.y, opts) : null
		if (net) useAppStore.getState().select(netSelection(net, data?.compiled ?? null))
	}
	// Right-click: the menu of what is under the cursor, then the nets there.
	const menuRef = useRef<(clientX: number, clientY: number, p: { x: number; y: number }) => void>(() => {})
	menuRef.current = (clientX, clientY, p) => {
		if (!scene) return
		lastClick.current = p
		const hits = stackAt(p)
		const nets = [...new Set(hits.flatMap(h => (h.kind === "object" && scene.objects[h.id]!.net ? [scene.objects[h.id]!.net!] : [])))]
		setMenu(hits.length ? { x: clientX, y: clientY, hits, nets } : null)
	}
	// Shift+Tab: the next thing under the last click after the one selected (wrapping round).
	const cycleRef = useRef<() => void>(() => {})
	cycleRef.current = () => {
		const p = lastClick.current
		if (!scene || !p) return
		const hits = stackAt(p)
		if (hits.length === 0) return
		const compiled = data?.compiled ?? null
		const at = (hitPosition(scene, hits, useAppStore.getState().selection, compiled) + 1) % hits.length
		useAppStore.getState().select(hitSelection(scene, hits[at]!, compiled))
		const { kind, label } = hitLabel(scene, hits[at]!, compiled)
		setCycleNote({ at: at + 1, of: hits.length, kind, label })
	}
	// Hovering anywhere inside a part (shown in the current layer view) outlines its box, while nothing is
	// selected. Holding Shift hovers nets instead: the net under the cursor on the current layer glows.
	const hoverRef = useRef<(p: { x: number; y: number } | null, shift: boolean) => void>(() => {})
	hoverRef.current = (p, shift) => {
		const idx = index.current
		const opts = hitOptions()
		let net = p && shift && idx && rules && opts ? netAt(idx, p.x, p.y, { ...opts, isShown: o => rules.isActive(o) && rules.isCurrent(o), isPartShown: () => false }) : null
		const held = shiftHover.current
		if (shift && held && !held.armed && p) {
			if (held.quiet === undefined) held.quiet = net
			if (net === held.quiet) net = null
			else held.armed = true
		}
		glowAt(net)
		const next = p && !shift && !selection && idx && rules ? componentAt(idx, p.x, p.y, rules.isPartActive) : null
		if (next === hoverComponent.current) return
		hoverComponent.current = next
		blit.current()
	}
	// A selection takes the hover box away until it is cleared.
	useEffect(() => {
		if (!selection || hoverComponent.current === null) return
		hoverComponent.current = null
		blit.current()
	}, [selection])
	// Point the glow at a net (or none) and ease every level toward its target, a frame at a time.
	const glowAt = (net: string | null) => {
		const g = glow.current
		if (net === g.target) return
		g.target = net
		if (net !== null) {
			// The hovered net is drawn last, over the ones fading out.
			const level = g.nets.get(net) ?? 0
			g.nets.delete(net)
			g.nets.set(net, level)
		}
		if (g.frame) return
		g.last = performance.now()
		const step = (now: number) => {
			const k = 1 - Math.exp(-(now - g.last) / GLOW_TAU)
			g.last = now
			let moving = false
			for (const [n, level] of g.nets) {
				const to = n === g.target ? 1 : 0
				const next = level + (to - level) * k
				if (to === 0 && next < 0.01) g.nets.delete(n)
				else g.nets.set(n, Math.abs(to - next) < 0.005 ? to : next)
				if (g.nets.has(n) && g.nets.get(n) !== to) moving = true
			}
			blit.current()
			g.frame = moving ? requestAnimationFrame(step) : 0
		}
		g.frame = requestAnimationFrame(step)
	}

	// Comparing: repaint when the marks or the layers shown change; go to a change picked from the list.
	useEffect(() => {
		blit.current()
	}, [artPaths, partPaths, layers, artwork?.focus])
	const focusArea = artwork?.focus ? artwork.areas[artwork.focus.area]?.box : undefined
	useEffect(() => {
		if (focusArea) fitRef.current(focusArea, 80)
	}, [artwork?.focus?.seq])

	// Frame the selection when another view or a panel link asks for it, on its side's copper layer (a
	// bottom-side part on BOTTOM); something on both sides keeps the current layer.
	useEffect(() => {
		if (pane.diff || !scene || !highlight?.frame || focusSeq === consumedFocus) return
		consumedFocus = focusSeq
		fitRef.current(highlight.frame, 150)
		const side = selectionSide(scene, selection, data?.compiled ?? null, highlight.objects)
		const key = side === "bottom" ? "BOTTOM" : side === "top" ? "TOP" : null
		if (key && scene.layers.some(l => l.key === key)) setLayers(prev => (prev && prev.current !== key ? makeCurrent(prev, key) : prev))
	}, [focusSeq, scene, highlight, selection, data])

	useEffect(() => {
		if (!layerLink || !layers || followsLayers) return
		layerLink.publish(layers, layerLink)
	}, [layerLink, layers, followsLayers])
	useEffect(() => {
		if (!layerLink || !followsLayers) return
		return layerLink.subscribe(v => setLayers(v))
	}, [layerLink, followsLayers])

	// Where the ruler's clicks land, in board terms: a point on the nearest thing to snap to within reach
	// (what the layer view makes active: with Current only or Highlight, only what is on the current layer), or where the cursor is with Ctrl held or nothing near; the circle
	// under the cursor; the cursor itself, for placing a dimension line.
	{
		const board = (clientX: number, clientY: number) => {
			const el = canvas.current, cam = camera.current
			if (!el || !cam) return null
			const r = el.getBoundingClientRect()
			const ratio = window.devicePixelRatio || 1
			const p = toBoardPoint(cam, el.width, el.height, (clientX - r.left) * ratio, (clientY - r.top) * ratio)
			return { ...p, reach: (SNAP_PX * ratio) / cam.scale, perMil: cam.scale / ratio }
		}
		hostRef.current = {
			point(clientX, clientY, free) {
				const p = board(clientX, clientY), idx = index.current
				if (!p || !scene || !idx || !rules) return null
				const kinds = useAppStore.getState().snapKinds
				const snap = free || kinds.size === 0 ? null : snapAt(scene, idx, p.x, p.y, { reach: p.reach, kinds, isShown: rules.isActive, pxPerMil: p.perMil })
				return snap ? { x: snap.x, y: snap.y, z: 0, snap: snap.kind, on: snap.on, target: snap.target } : { x: p.x, y: p.y, z: 0, snap: null, on: null }
			},
			circle(clientX, clientY) {
				const p = board(clientX, clientY), idx = index.current
				if (!p || !scene || !idx || !rules) return null
				const c = circleAt(scene, idx, p.x, p.y, { reach: p.reach, isShown: rules.isActive })
				if (!c) return null
				const d = Math.hypot(p.x - c.x, p.y - c.y)
				const [ux, uy] = d > 1e-6 ? [(p.x - c.x) / d, (p.y - c.y) / d] : [1, 0]
				return { a: { x: c.x, y: c.y, z: 0, snap: "center", on: c.on }, b: { x: c.x + ux * c.r, y: c.y + uy * c.r, z: 0, snap: "edge", on: c.on } }
			},
			place(clientX, clientY) {
				const p = board(clientX, clientY)
				return p && { x: p.x, y: p.y, z: 0 }
			},
		}
	}
	// The kind of measurement changed (in the bar): what is being made redrawn as that kind.
	const measureMode = useAppStore(s => s.measureMode)
	useEffect(() => {
		if (measuringRef.current) tool.refresh()
	}, [measureMode, tool])
	// The ruler off (or another tab shown): the measurement being made is dropped.
	useEffect(() => {
		if (measuring) return
		tool.reset()
		blit.current()
	}, [measuring])
	// Measurements added, changed or removed (here, in the panel, or in the 3D view), and the selection.
	useEffect(() => {
		blit.current()
	}, [measures, selection])

	// Keyboard: +/- step the current layer, Shift+S the layer mode, F mirrors, Esc clears the selection,
	// Shift+Tab steps through what is under the last click. The ruler: M turns it on or off, Space
	// cycles what is measured, Esc drops the measurement being made (else turns it off), Delete removes
	// a selected measurement.
	useEffect(() => {
		if (!scene || !active || followsLayers) return
		const onKey = (e: KeyboardEvent) => {
			if ((e.target as Element | null)?.closest?.("input, textarea, select, [contenteditable]")) return
			if (measureKey(e, tool)) return
			if (e.key === "Escape") useAppStore.getState().select(null)
			if (e.ctrlKey || e.metaKey || e.altKey) return
			if (e.key === "Tab" && e.shiftKey) {
				e.preventDefault()
				return cycleRef.current()
			}
			const change = (f: (s: LayerState) => LayerState) => {
				e.preventDefault()
				setLayers(prev => (prev ? f(prev) : prev))
			}
			if (e.code === "KeyS" && e.shiftKey) return change(nextMode)
			if (e.code === "KeyF" && !e.shiftKey) return change(prev => ({ ...prev, flip: !prev.flip }))
			if ((e.code === "KeyQ" || e.code === "KeyE") && !e.shiftKey) {
				e.preventDefault()
				return rotateRef.current(e.code === "KeyQ" ? -1 : 1)
			}
			if (e.key === "+" || e.key === "=") return change(prev => cycleCurrent(prev, scene, 1))
			if (e.key === "-") return change(prev => cycleCurrent(prev, scene, -1))
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [scene, active, followsLayers])

	// The cycle note fades after a moment; the next step or click replaces it.
	useEffect(() => {
		if (!cycleNote) return
		const t = window.setTimeout(() => setCycleNote(null), CYCLE_NOTE_MS)
		return () => clearTimeout(t)
	}, [cycleNote])

	// The pick menu's rows: each thing under the cursor (the selected one marked), then each net there.
	const menuRows = (s: PcbScene, m: { hits: PcbHit[]; nets: string[] }): PickRow[] => {
		const compiled = data?.compiled ?? null
		const current = hitPosition(s, m.hits, selection, compiled)
		const selectedNet = selection ? pcbNetName(selection, compiled)?.toUpperCase() : undefined
		return [
			...m.hits.map((h, i) => ({ key: `hit:${i}`, ...hitLabel(s, h, compiled), current: i === current })),
			...m.nets.map((n, i) => ({ key: `net:${n}`, kind: "Net", label: n, detail: "", current: n.toUpperCase() === selectedNet, section: i === 0 ? "Nets" : undefined })),
		]
	}
	// The row under the mouse outlines what it stands for on the board.
	const previewRow = (key: string | null) => {
		const hit = key?.startsWith("hit:") && menu ? menu.hits[Number(key.slice(4))] : undefined
		previewObject.current = hit?.kind === "object" ? hit.id : null
		hoverComponent.current = hit?.kind === "component" ? hit.index : null
		blit.current()
	}
	const closeMenuRef = useRef(() => {})
	closeMenuRef.current = () => {
		setMenu(null)
		previewRow(null)
	}
	const closeMenu = useRef(() => closeMenuRef.current()).current
	const pickRow = (key: string) => {
		if (!scene || !menu) return
		const compiled = data?.compiled ?? null
		const { select } = useAppStore.getState()
		if (key.startsWith("net:")) select(netSelection(key.slice(4), compiled))
		else select(hitSelection(scene, menu.hits[Number(key.slice(4))]!, compiled))
		closeMenu()
	}

	return (
		<div className={`pcb-view${measuring ? " measuring" : ""}`} ref={frame} data-status={load.status}>
			<canvas ref={canvas} className="pcb-canvas" />
			{load.status === "loading" && <div className="view-message">Loading board…</div>}
			{load.status === "none" && <div className="view-message">This project has no board</div>}
			{load.status === "error" && <div className="view-message error">{load.message}</div>}
			{scene &&
				layers &&
				panelOpen &&
				!followsLayers &&
				(() => {
					const panel = (
						<LayersPanel scene={scene} state={layers} onChange={setLayers} onReset={() => setLayers(defaultLayerState(scene))} onClose={() => useAppStore.getState().setPcbPanelOpen(false)} />
					)
					return pane.panelHost ? createPortal(panel, pane.panelHost) : panel
				})()}
			{measuring && <MeasureBar view="pcb" />}
			{measuring && <MeasureLegend />}
			{scene && layers && layers.flip && (
				<button className="pcb-mirror-badge" onClick={() => !followsLayers && setLayers({ ...layers, flip: false })} disabled={followsLayers}>
					<FlipHorizontal2 size={14} />
					Mirrored · viewed from the bottom
				</button>
			)}
			{cycleNote && (
				<div className="pcb-cycle-note" role="status">
					<span className="dim">
						{cycleNote.at} / {cycleNote.of} · {cycleNote.kind}
					</span>{" "}
					{cycleNote.label}
				</div>
			)}
			{menu && scene && <PickMenu x={menu.x} y={menu.y} rows={menuRows(scene, menu)} onPick={pickRow} onHover={previewRow} onClose={closeMenu} />}
			{scene && layers && !followsLayers && <LayerLegend scene={scene} state={layers} onChange={setLayers} shifted={panelOpen && !pane.panelHost} />}
			{/* A modal over the whole app (outside the board's pointer handling); side by side, the left board's. */}
			{stackupOpen &&
				active &&
				!followsLayers &&
				data?.pcb &&
				data.pcb.stackup.length > 0 &&
				createPortal(<StackupDialog stackup={data.pcb.stackup} colors={new Map(data.pcb.layers.map(l => [l.key, l.color]))} onClose={closeStackup} />, document.body)}
		</div>
	)
}
