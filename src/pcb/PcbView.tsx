import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useAppStore } from "../app/store"
import { usePane, usePaneData, usePaneSelection, type ViewLink } from "../app/pane"
import { whenIdle } from "../app/idle"
import type { Parser } from "../parse/parser"
import { buildRenderCache, CANVAS_BG, drawComponentBox, drawPcb, type PcbCamera, type PcbRenderCache } from "./draw"
import { drawLabels } from "./labels"
import { buildIndex, componentAt, hitTest, objectsIn, type PcbIndex } from "./hit"
import { LayersPanel } from "./LayersPanel"
import { componentSelection, netSelection, pcbHighlight } from "./selection"
import type { PcbObject, PcbScene } from "./scene"
import { usePcbScene } from "./use-scene"
import { StackupDialog } from "./StackupDialog"
import { LayerLegend } from "./LayerLegend"
import { cycleCurrent, nextMode, onlyLayer, type LayerState } from "./layer-state"
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
const BITMAP_MARGIN = 0.5 // the offscreen board extends half a view beyond each edge
const SETTLE_MS = 120
const REDRAW_EVERY = 150
const DRAFT_QUALITY = 0.5
const HIT_PX = 3 // click tolerance in screen pixels


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
const inPanel = (e: Event) => (e.target as Element | null)?.closest?.(".pcb-layers, .pcb-legend, .pcb-mirror-badge") != null

const closeStackup = () => useAppStore.getState().setPcbStackupOpen(false)

export function PcbView({ parser, active = true }: { parser: Parser; active?: boolean }) {
	const pane = usePane()
	const projectData = usePaneData()
	const selection = usePaneSelection()
	const focusSeq = useAppStore(s => s.pcbFocusSeq)
	const mark = pane.mark && !pane.mark.mostly ? pane.mark : null
	// Side by side, both boards show the same place: the camera is shared through the pane's link.
	const link = useRef<ViewLink<{ cx: number; cy: number; scale: number }> | null>(null)
	link.current = (pane.links?.pcb as ViewLink<{ cx: number; cy: number; scale: number }> | undefined) ?? null
	const panelOpen = useAppStore(s => s.pcbPanelOpen)
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
	const canvases = useRef<HTMLCanvasElement[]>([])
	const blit = useRef<() => boolean>(() => false)
	const timing = useRef({ board: 0, labels: 0 })
	const labelRules = useRef<{ isActive(o: PcbObject): boolean; isCurrent(o: PcbObject): boolean } | null>(null)
	const bitmap = useRef<{ canvas: HTMLCanvasElement; camera: PcbCamera; at: number } | null>(null)
	const selectedBox = useRef<number[] | null>(null)
	const hoverComponent = useRef<number | null>(null)

	const load = usePcbScene(parser, data, projectData.status === "error" ? projectData.message : null)
	const scene = load.status === "ready" ? load.scene : null
	// Render caches and default layers follow the scene.
	const [prepared, setPrepared] = useState<PcbScene | null>(null)
	if (scene && prepared !== scene) {
		cache.current = buildRenderCache(scene)
		index.current = buildIndex(scene)
		setPrepared(scene)
		setLayers((followsLayers ? layerLink?.last?.value : null) ?? savedViews.get(scene)?.layers ?? defaultLayerState(scene))
	}
	// Comparing: what only this commit has, in red (removed) or green (added), over a greyed board.
	const highlight = useMemo(
		() => (mark ? { objects: mark.ids, outline: null, componentBox: null, frame: null } : scene ? pcbHighlight(scene, selection, data?.compiled ?? null) : null),
		[scene, selection, data, mark],
	)
	const tone = mark ? (mark.tone === "removed" ? DIFF_REMOVED : DIFF_ADDED) : null

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
		return {
			isShown,
			isCurrent,
			// What is labelled, hovered and picked: in highlight mode only what is on the current layer (the
			// rest of the board is greyed out), else everything shown.
			isActive: layers.mode === "highlight" ? (o: PcbObject) => isShown(o) && isCurrent(o) : isShown,
		}
	}, [scene, layers])
	labelRules.current = rules
	useEffect(() => {
		if (!scene || !layers) return
		const entry = savedViews.get(scene)
		if (entry) entry.layers = layers
		else savedViews.set(scene, { camera: null, layers })
	}, [scene, layers])
	selectedBox.current = highlight?.componentBox ?? null

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
		const width = Math.round(el.width * quality * (1 + 2 * BITMAP_MARGIN))
		const height = Math.round(el.height * quality * (1 + 2 * BITMAP_MARGIN))
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
			tone,
		})
		const t1 = performance.now()
		timing.current = { board: t1 - t0, labels: performance.now() - t1 }
		bitmap.current = { canvas: off, camera: { ...cam }, at: performance.now() }
		blit.current()
	}
	// Paints the current view from the bitmap. False when the bitmap leaves part of the view uncovered.
	blit.current = () => {
		const el = canvas.current
		const cam = camera.current
		const b = bitmap.current
		const ctx = el?.getContext("2d")
		if (!el || !cam || !b || !ctx) return false
		const s = cam.scale / b.camera.scale
		const f = cam.flip ? -1 : 1
		const cx = el.width / 2 + f * (b.camera.cx - cam.cx) * cam.scale
		const cy = el.height / 2 - (b.camera.cy - cam.cy) * cam.scale
		const w = b.canvas.width * s
		const h = b.canvas.height * s
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.fillStyle = CANVAS_BG
		ctx.fillRect(0, 0, el.width, el.height)
		ctx.imageSmoothingEnabled = true
		ctx.drawImage(b.canvas, cx - w / 2, cy - h / 2, w, h)
		// Labels are drawn on the live view, not into the bitmap, so they stay sharp and sized right
		// while zooming instead of stretching with the bitmap and popping when it settles.
		const idx = index.current
		const rules = labelRules.current
		if (idx && rules) {
			const halfW = el.width / 2 / cam.scale
			const halfH = el.height / 2 / cam.scale
			drawLabels(ctx, objectsIn(idx, cam.cx - halfW, cam.cy - halfH, cam.cx + halfW, cam.cy + halfH), cam, rules.isActive, rules.isCurrent)
		}
		// The selected part's box (green, hatched) and the hovered part's box (outline only).
		const hovered = hoverComponent.current !== null ? scene?.components[hoverComponent.current]?.box : undefined
		if (hovered && hovered !== selectedBox.current) drawComponentBox(ctx, cam, hovered, false)
		if (selectedBox.current) drawComponentBox(ctx, cam, selectedBox.current, true)
		return cx - w / 2 <= 0 && cy - h / 2 <= 0 && cx + w / 2 >= el.width && cy + h / 2 >= el.height
	}
	// Redraw when what is shown changes. While another tab is showing, the redraw waits for idle time
	// (a selection made in SCH or 3D must not stall on this view); it runs at once if the tab comes back
	// first, and coming back with nothing changed draws nothing.
	const drawnFor = useRef<unknown[]>([])
	useEffect(() => {
		const inputs = [layers, highlight, scene, rules]
		if (inputs.every((v, i) => v === drawnFor.current[i])) return
		const draw = () => {
			drawnFor.current = inputs
			redraw.current()
		}
		if (active) return draw()
		return whenIdle(draw)
	}, [layers, highlight, scene, rules, active])

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
			camera.current = { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, scale, flip: camera.current?.flip ?? false }
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
		}

		let frameReq = 0
		// While the view moves: shift/scale the bitmap every frame, redraw the board when it settles, or
		// sooner when the bitmap no longer covers the view (at most every REDRAW_EVERY ms).
		let settle = 0
		const schedule = (publish = true) => {
			const cam = camera.current
			if (publish && cam) shared?.publish({ cx: cam.cx, cy: cam.cy, scale: cam.scale }, me)
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
			const px = (clientX - r.left) * dpr(), py = (clientY - r.top) * dpr()
			return { x: cam.cx + ((cam.flip ? -1 : 1) * (px - el.width / 2)) / cam.scale, y: cam.cy - (py - el.height / 2) / cam.scale }
		}
		// For the browser tests: the scene, and where a board point is on screen.
		Object.assign(el, {
			__pcb: {
				scene,
				toClient(x: number, y: number) {
					const r = el.getBoundingClientRect()
					const cam = camera.current!
					return {
						x: r.left + (el.width / 2 + (cam.flip ? -1 : 1) * (x - cam.cx) * cam.scale) / dpr(),
						y: r.top + (el.height / 2 - (y - cam.cy) * cam.scale) / dpr(),
					}
				},
				camera: () => ({ ...camera.current! }),
				layers: () => layersRef.current,
				timing: () => ({ ...timing.current }),
				hover: () => hoverComponent.current,
				pick: (x: number, y: number) => pickRef.current({ x, y }),
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
		const onMove = (e: PointerEvent) => {
			if (!drag) {
				if (!inPanel(e)) hoverRef.current(toWorld(e.clientX, e.clientY))
				return
			}
			if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < CLICK_SLOP) return
			if (!drag.moved) fr.classList.add("panning")
			drag.moved = true
			const cam = camera.current!
			cam.cx -= ((cam.flip ? -1 : 1) * (e.clientX - drag.x) * dpr()) / cam.scale
			cam.cy += ((e.clientY - drag.y) * dpr()) / cam.scale
			drag.x = e.clientX
			drag.y = e.clientY
			schedule()
		}
		const onUp = (e: PointerEvent) => {
			const click = drag !== null && !drag.moved && drag.button === 0 && e.type === "pointerup"
			drag = null
			fr.classList.remove("panning")
			if (click) clickRef.current(toWorld(e.clientX, e.clientY))
		}
		// Double-click on anything with a net selects and highlights the whole net.
		const onDouble = (e: MouseEvent) => {
			if (inPanel(e)) return
			doubleRef.current(toWorld(e.clientX, e.clientY))
		}
		const onLeave = () => hoverRef.current(null)
		// Right-click does nothing here (no browser menu over the board).
		const onMenu = (e: Event) => e.preventDefault()
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
			ro?.disconnect()
		}
	}, [scene])

	const fitRef = useRef<(b: [number, number, number, number], minWidth: number) => void>(() => {})
	const clickRef = useRef<(p: { x: number; y: number }) => void>(() => {})
	const pick = (p: { x: number; y: number }) => {
		const idx = index.current
		const cam = camera.current
		if (!scene || !idx || !cam || !layers || !rules) return null
		return hitTest(idx, p.x, p.y, {
			tolerance: (HIT_PX * (window.devicePixelRatio || 1)) / cam.scale,
			isShown: rules.isActive,
			current: layers.current,
			side: layers.flip ? "bottom" : "top",
		})
	}
	const pickRef = useRef<(p: { x: number; y: number }) => ReturnType<typeof pick>>(() => null)
	pickRef.current = pick
	clickRef.current = p => {
		const { select } = useAppStore.getState()
		const hit = pick(p)
		if (!scene || !hit) return select(null)
		if (hit.kind === "object") return select({ kind: "pcbObject", id: hit.id })
		select(componentSelection(scene, hit.index, data?.compiled ?? null))
	}
	const doubleRef = useRef<(p: { x: number; y: number }) => void>(() => {})
	doubleRef.current = p => {
		const hit = pick(p)
		const net = hit?.kind === "object" ? scene?.objects[hit.id]?.net : null
		if (net) useAppStore.getState().select(netSelection(net, data?.compiled ?? null))
	}
	// Hovering anywhere inside a part (shown in the current layer view) outlines its box.
	const hoverRef = useRef<(p: { x: number; y: number } | null) => void>(() => {})
	hoverRef.current = p => {
		const idx = index.current
		const next = p && idx && rules ? componentAt(idx, p.x, p.y, rules.isActive) : null
		if (next === hoverComponent.current) return
		hoverComponent.current = next
		blit.current()
	}

	// Frame the selection when another view or a panel link asks for it.
	useEffect(() => {
		if (pane.diff || !scene || !highlight?.frame || focusSeq === consumedFocus) return
		consumedFocus = focusSeq
		fitRef.current(highlight.frame, 150)
	}, [focusSeq, scene, highlight])

	useEffect(() => {
		if (!layerLink || !layers || followsLayers) return
		layerLink.publish(layers, layerLink)
	}, [layerLink, layers, followsLayers])
	useEffect(() => {
		if (!layerLink || !followsLayers) return
		return layerLink.subscribe(v => setLayers(v))
	}, [layerLink, followsLayers])

	// Keyboard: +/- step the current layer, Shift+S the layer mode, F mirrors, Esc clears the selection.
	useEffect(() => {
		if (!scene || !active || followsLayers) return
		const onKey = (e: KeyboardEvent) => {
			if ((e.target as Element | null)?.closest?.("input, textarea, select, [contenteditable]")) return
			if (e.key === "Escape") useAppStore.getState().select(null)
			if (e.ctrlKey || e.metaKey || e.altKey) return
			const change = (f: (s: LayerState) => LayerState) => {
				e.preventDefault()
				setLayers(prev => (prev ? f(prev) : prev))
			}
			if (e.code === "KeyS" && e.shiftKey) return change(nextMode)
			if (e.code === "KeyF" && !e.shiftKey) return change(prev => ({ ...prev, flip: !prev.flip }))
			if (e.key === "+" || e.key === "=") return change(prev => cycleCurrent(prev, scene, 1))
			if (e.key === "-") return change(prev => cycleCurrent(prev, scene, -1))
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [scene, active, followsLayers])

	return (
		<div className="pcb-view" ref={frame} data-status={load.status}>
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
			{scene && layers && layers.flip && (
				<button className="pcb-mirror-badge" onClick={() => !followsLayers && setLayers({ ...layers, flip: false })} disabled={followsLayers}>
					<FlipHorizontal2 size={14} />
					Mirrored · viewed from the bottom
				</button>
			)}
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
