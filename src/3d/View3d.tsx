import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type * as THREE from "three"
import { EyeOff } from "lucide-react"
import { useAppStore, type Projection3d } from "../app/store"
import { usePane, usePaneData, usePaneSelection, type ViewLink } from "../app/pane"
import type { Parser } from "../parse/parser"
import { componentSelection, netSelection, pcbNetName, partIndex, partKey, partLabel, pcbComponentIndex, pcbHighlight, selectionSide } from "../pcb/selection"
import { LAYER_MODES, MODE_NAMES, type LayerMode } from "../pcb/layer-state"
import type { PcbScene } from "../pcb/scene"
import { BoardEngine, type CameraState } from "./engine"
import { whenIdle } from "../app/idle"
import { HIDDEN_3D_BY_DEFAULT, ObjectsPanel, type Objects3dState } from "./ObjectsPanel"
import { ViewCube } from "./ViewCube"
import { load3d, type Loaded3d } from "./prefetch"
import type { GeoMesh } from "./board-geometry"
import { drawMeasure, drawSnapMarker, measureAt, type DrawnMeasure } from "../measure/draw"
import { MeasureBar, MeasureLegend } from "../measure/MeasureBar"
import { MeasureTool, measureKey } from "../measure/tool"
import { buildSolder } from "./solder"
import type { StepQuality } from "./step-export/options"
import { notFittedPaths, type ProjectVariant } from "../model/variants"

// The camera and Objects settings per board, kept with the board.
const savedViews = new WeakMap<PcbScene, { camera: CameraState | null; objects: Objects3dState }>()
let consumedFocus = 0
const LAYER_NOTE_MS = 1500 // the current layer's name, shown a moment after Ctrl+Shift+wheel
const GLOW_CACHE = 8 // nets whose glow geometry is kept
const TAG_GAP = 10 // px between a net label and the point it is pinned to
const TAG_MARGIN = 24 // px: a label's point is kept this far inside the canvas
const TAG_SPACE = 6 // px kept clear between two labels
const MAX_NETS = 8 // nets highlighted at once (Shift+double-click adds to the selected one)
const SNAP_PX = 10 // CSS px: how far the ruler reaches for something to snap to

const defaultObjects = (): Objects3dState => ({ side: null, hiddenKinds: new Set(HIDDEN_3D_BY_DEFAULT) })

// The 3D tab. It stays mounted once opened (tab switches only hide it), so coming back is instant.
export function View3d({
	parser,
	active,
	board,
	readBoard,
	variants,
	name = "board",
}: {
	parser: Parser
	active: boolean
	board: string // boardKey: which board, so the load started when the project opened is found
	readBoard(): Promise<Uint8Array>
	variants?: ProjectVariant[]
	name?: string
}) {
	const pane = usePane()
	const projectData = usePaneData()
	const selection = usePaneSelection()
	const focusSeq = useAppStore(s => s.view3dFocusSeq)
	const link = useRef<ViewLink<CameraState> | null>(null)
	link.current = (pane.links?.view3d as ViewLink<CameraState> | undefined) ?? null
	const panelOpen = useAppStore(s => s.view3dPanelOpen)
	const projection = useAppStore(s => s.view3dProjection)
	const variant = useAppStore(s => s.variant)
	const hiddenParts = useAppStore(s => s.view3dHidden)
	const data = projectData.status === "ready" ? projectData.data : null
	const canvas = useRef<HTMLCanvasElement>(null)
	// What was loaded, and for which board: another board (a different project opened) shows the loading
	// screen until its own load is in, never the last board's.
	const [loadedFor, setLoadedFor] = useState<{ board: string; value: Loaded3d | null } | undefined>(undefined)
	const loaded = loadedFor && loadedFor.board === board ? loadedFor.value : undefined
	const setLoaded = (value: Loaded3d | null) => setLoadedFor({ board, value })
	const [ready, setReady] = useState<BoardEngine | null>(null)
	const [objects, setObjects] = useState<Objects3dState>(defaultObjects)
	const [progress, setProgress] = useState({ done: 0, total: 0 })
	const scene = loaded?.scene ?? null
	// The current layer and the layer mode (Shift+S), as in the PCB view.
	const [layerView, setLayerView] = useState<{ current: string; mode: LayerMode }>({ current: "TOP", mode: "all" })
	const [layerNote, setLayerNote] = useState(0)
	// Net labels: the Shift-hovered pad's net, pinned to the pad; each highlighted net beside its copper,
	// wherever the view is (see placeTags).
	const [hoverNet, setHoverNet] = useState<string | null>(null)
	const hoverTag = useRef<HTMLDivElement>(null)
	// The ruler (shared with the PCB view): its measurements drawn on a canvas over the board, and the
	// one being made here.
	const measuring = useAppStore(s => s.measuring) && active && !pane.diff
	const measuringRef = useRef(measuring)
	measuringRef.current = measuring
	const measures = useAppStore(s => s.measures)
	const overlay = useRef<HTMLCanvasElement>(null)
	const drawnMeasures = useRef<DrawnMeasure[]>([])
	const engineRef = useRef<BoardEngine | null>(null)
	const drawOverlay = useRef(() => {})
	const toolRef = useRef<MeasureTool | null>(null)
	toolRef.current ??= new MeasureTool("3d", {
		point: (x, y, free) => engineRef.current?.measurePoint(x, y, free ? null : { kinds: useAppStore.getState().snapKinds, reachPx: SNAP_PX }) ?? null,
		circle: (x, y) => engineRef.current?.measureCircle(x, y, SNAP_PX) ?? null,
		place: (x, y, m) => engineRef.current?.measurePlace(x, y, m) ?? null,
		scaleAt: p => engineRef.current?.canvasProjector(1).scaleAt(p) ?? 0,
		redraw: () => drawOverlay.current(),
	})
	const tool = toolRef.current
	const ctrlHeld = useRef(false)
	const netTags = useRef(new Map<string, HTMLDivElement>())
	const anchors = useRef<{ hover: THREE.Vector3 | null }>({ hover: null })
	// Nets added to the highlight with Shift+double-click, beside the selection's (cleared with it).
	const [extraNets, setExtraNets] = useState<string[]>([])
	const selectedNetRef = useRef<string | null>(null)

	// Export STEP (the doc bar's button): run in the 3D worker once the board is in, then saved as a
	// file. Only the primary pane answers it.
	const exportSeq = useAppStore(s => s.stepExportSeq)
	const exportOptions = useAppStore(s => s.stepExportOptions)
	const exportedSeq = useRef(exportSeq)
	useEffect(() => {
		if (exportSeq === exportedSeq.current || pane.side !== "primary" || !loaded) return
		exportedSeq.current = exportSeq
		const { setStepExporting } = useAppStore.getState()
		setStepExporting(true)
		loaded
			.exportStep(name, exportOptions)
			.then(r => {
				const url = URL.createObjectURL(new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: "model/step" }))
				const a = document.createElement("a")
				a.href = url
				a.download = `${name}.step`
				document.body.append(a)
				a.click()
				a.remove()
				setTimeout(() => URL.revokeObjectURL(url), 1000)
			})
			.catch(e => console.error("STEP export failed", e))
			.finally(() => setStepExporting(false))
	}, [exportSeq, exportOptions, loaded, pane.side, name])
	// The export dialog's size estimate, worked out by the same worker when the dialog asks (the whole
	// board exported a few times over: too heavy to run unasked).
	useEffect(() => {
		if (pane.side !== "primary" || !loaded) return
		const { setStepEstimator } = useAppStore.getState()
		setStepEstimator((quality: StepQuality) => loaded.estimateStep(quality))
		return () => setStepEstimator(null)
	}, [loaded, pane.side])

	// Everything is fetched (usually already, in the background) before anything is shown.
	useEffect(() => {
		if (!data) return
		if (!data.pcb) return setLoaded(null)
		const load = load3d(parser, data, board, readBoard, pane.side)
		setProgress({ done: 0, total: 0 })
		let live = true
		const tick = setInterval(() => live && setProgress({ ...load.progress }), 150)
		load.done.then(
			r => live && setLoaded(r),
			() => live && setLoaded(null),
		)
		return () => {
			live = false
			clearInterval(tick)
		}
	}, [parser, data])

	// Building the engine blocks the main thread for a few hundred ms (shaders, meshes). Shown, it is built
	// at once; built ahead while hidden, it waits until the user pauses, so it can't stall a pan or zoom in
	// the view being used.
	const [buildFor, setBuildFor] = useState<Loaded3d | null>(null)
	useEffect(() => {
		if (!loaded || buildFor === loaded) return
		if (active) return setBuildFor(loaded)
		return whenIdle(() => setBuildFor(loaded))
	}, [loaded, active, buildFor])
	const build = loaded !== null && buildFor === loaded

	// One engine per board, built with every part in place, its shaders compiled before it is shown.
	useEffect(() => {
		const el = canvas.current
		if (!el || !loaded || !build) return
		const { scene, board, geometry, models } = loaded
		const saved = savedViews.get(scene)
		const me = {}
		const shared = link.current
		const e = new BoardEngine(el, scene, board, geometry, {
			pick: (hit, clientX, clientY) => {
				if (shared) return // side by side: no selection (ids differ between the commits)
				if (measuringRef.current) return tool.click(clientX, clientY, ctrlHeld.current)
				if (shiftClick) return // Shift+click leaves the selection be (Shift+double-click adds a net)
				const state = useAppStore.getState()
				// A measurement is picked over the board under it.
				const r = el.getBoundingClientRect(), ratio = window.devicePixelRatio || 1
				const measure = measureAt(drawnMeasures.current, { x: (clientX - r.left) * ratio, y: (clientY - r.top) * ratio }, ratio)
				if (measure !== null) return state.select({ kind: "measure", id: measure })
				const compiled = state.projectData.status === "ready" ? state.projectData.data.compiled : null
				if (!hit) return state.select(null)
				state.select(hit.kind === "component" ? componentSelection(scene, hit.index, compiled) : { kind: "pcbObject", id: hit.id })
			},
			changed: () => {
				const entry = savedViews.get(scene)
				if (entry) entry.camera = e.getView()
				shared?.publish(e.getView(), me)
			},
			// Ctrl+Shift+wheel steps the current layer, one step per notch (a trackpad's small deltas add up
			// to a notch first); wheel up: the next layer down.
			layerWheel: w => {
				layerWheel += (w.deltaY || w.deltaX) * (w.deltaMode === 1 ? 33 : w.deltaMode === 2 ? 400 : 1)
				if (Math.abs(layerWheel) < 40) return
				const dir = layerWheel > 0 ? -1 : 1
				layerWheel = 0
				const keys = e.layerKeys()
				if (keys.length === 0) return
				setLayerView(v => ({ ...v, current: keys[(keys.indexOf(v.current) + dir + keys.length) % keys.length]! }))
				setLayerNote(performance.now())
			},
		})
		let layerWheel = 0
		let shiftClick = false
		const unlink = shared?.subscribe((v, from) => from !== me && e.setView(v))
		;(el as HTMLCanvasElement & { __view3d?: BoardEngine }).__view3d = e
		for (const [key, mesh] of models) e.setModel(key, mesh)
		e.setProjection(useAppStore.getState().view3dProjection)
		if (shared?.last) e.setView(shared.last.value)
		else if (saved?.camera) e.setView(saved.camera)
		setObjects(saved?.objects ?? defaultObjects())
		if (!saved) savedViews.set(scene, { camera: null, objects: defaultObjects() })
		const observer = new ResizeObserver(() => e.resize())
		observer.observe(el)

		// Double-click selects the net of the copper under the cursor (a part's pin: looking past its body).
		// With Shift it adds the net to those highlighted (or takes an added one away again); the oldest
		// added goes when MAX_NETS are lit.
		const onDouble = (ev: MouseEvent) => {
			if (shared || measuringRef.current) return
			const net = e.netAt(ev.clientX, ev.clientY)
			if (!net) return
			const state = useAppStore.getState()
			const base = selectedNetRef.current
			if (ev.shiftKey && state.selection) {
				if (net === base) return
				return setExtraNets(prev => (prev.includes(net) ? prev.filter(n => n !== net) : [...prev, net].slice(-(MAX_NETS - (base ? 1 : 0)))))
			}
			state.select(netSelection(net, state.projectData.status === "ready" ? state.projectData.data.compiled : null))
		}
		// Holding Shift over a pad lights up its net. The net under it when Shift goes down stays dark
		// until the cursor moves onto another one (or off copper and back), as in the PCB view.
		const glowCache = new Map<string, GeoMesh[]>()
		let pointer: { x: number; y: number } | null = null
		let held: { quiet: string | null | undefined; armed: boolean } | null = null
		let target: string | null = null
		const glowTo = (net: string | null) => {
			if (net === target) return
			target = net
			anchors.current.hover = net !== null && pointer ? e.boardPoint(pointer.x, pointer.y) : null
			setHoverNet(net)
			if (net === null) return e.setGlow(null)
			const cached = glowCache.get(net)
			if (cached) return e.setGlow(net, cached)
			e.setGlow(null)
			const ids = scene.objects.filter(o => o.net === net).map(o => o.id)
			loaded.highlight(ids).then(meshes => {
				glowCache.set(net, meshes)
				if (glowCache.size > GLOW_CACHE) glowCache.delete(glowCache.keys().next().value!)
				if (target === net) e.setGlow(net, meshes)
			})
		}
		const hover = (shift: boolean) => {
			let net = pointer && shift ? e.netAt(pointer.x, pointer.y, true) : null
			if (shift && held && !held.armed && pointer) {
				if (held.quiet === undefined) held.quiet = net
				if (net === held.quiet) net = null
				else held.armed = true
			}
			glowTo(net)
		}
		const onDown = (ev: PointerEvent) => {
			shiftClick = ev.shiftKey
			ctrlHeld.current = ev.ctrlKey
		}
		const onMove = (ev: PointerEvent) => {
			pointer = { x: ev.clientX, y: ev.clientY }
			ctrlHeld.current = ev.ctrlKey
			if (ev.buttons === 0 && measuringRef.current) tool.move(ev.clientX, ev.clientY, ev.ctrlKey)
			if (ev.buttons === 0) hover(ev.shiftKey)
		}
		const onLeave = () => {
			pointer = null
			if (measuringRef.current) tool.leave()
			if (held) held.quiet = null
			hover(false)
		}
		const onShift = (ev: KeyboardEvent) => {
			// Ctrl turns the ruler's snapping off while held: the marker follows at once.
			if (ev.key === "Control" && !ev.repeat) {
				ctrlHeld.current = ev.type === "keydown"
				if (measuringRef.current) tool.refresh(ctrlHeld.current)
				return
			}
			if (ev.key !== "Shift" || ev.repeat) return
			const down = ev.type === "keydown"
			held = down ? { quiet: pointer ? undefined : null, armed: false } : null
			hover(down)
		}
		const onBlur = () => {
			held = null
			hover(false)
		}
		el.addEventListener("dblclick", onDouble)
		el.addEventListener("pointerdown", onDown)
		el.addEventListener("pointermove", onMove)
		el.addEventListener("pointerleave", onLeave)
		window.addEventListener("keydown", onShift)
		window.addEventListener("keyup", onShift)
		window.addEventListener("blur", onBlur)
		e.warmUp()
		setReady(e)
		return () => {
			el.removeEventListener("dblclick", onDouble)
			el.removeEventListener("pointerdown", onDown)
			el.removeEventListener("pointermove", onMove)
			el.removeEventListener("pointerleave", onLeave)
			window.removeEventListener("keydown", onShift)
			window.removeEventListener("keyup", onShift)
			window.removeEventListener("blur", onBlur)
			unlink?.()
			observer.disconnect()
			e.dispose()
			setReady(null)
		}
	}, [loaded, build])

	useEffect(() => {
		if (!scene) return
		const entry = savedViews.get(scene)
		if (entry) entry.objects = objects
	}, [scene, objects])

	useEffect(() => {
		ready?.setProjection(projection)
	}, [ready, projection])

	useEffect(() => {
		ready?.setHiddenKinds(objects.hiddenKinds)
	}, [ready, objects.hiddenKinds])

	useEffect(() => {
		ready?.setLayerView(layerView.current, layerView.mode)
	}, [ready, layerView])

	// The current layer's name shows a moment after it changes (and stays while a layer mode is on).
	useEffect(() => {
		if (!layerNote) return
		const t = window.setTimeout(() => setLayerNote(0), LAYER_NOTE_MS)
		return () => clearTimeout(t)
	}, [layerNote])

	// Solder joints: built from the parts' models the first time they are shown (off by default).
	const solderShown = !objects.hiddenKinds.has("solder")
	useEffect(() => {
		if (!ready || !loaded || !solderShown || ready.hasSolder) return
		const t0 = performance.now()
		ready.setSolder(buildSolder(loaded.scene, loaded.board, loaded.models, ready.frame))
		ready.timing.solder = performance.now() - t0
	}, [ready, loaded, solderShown])

	// The shown variant's not-fitted parts are left off the board.
	useEffect(() => {
		if (!ready || !scene) return
		const off = notFittedPaths(variants, variant)
		const hidden = new Set<number>()
		scene.components.forEach((c, i) => off.has(c.sourceUniqueId.toUpperCase()) && hidden.add(i))
		ready.setNotFitted(hidden)
		canvas.current?.setAttribute("data-not-fitted", String(hidden.size))
	}, [ready, scene, variants, variant])

	// Parts hidden by hand (Inspector / Objects panel), by partKey.
	useEffect(() => {
		if (!ready || !scene) return
		const hidden = new Set<number>()
		for (const key of hiddenParts) {
			const i = partIndex(scene, key)
			if (i >= 0) hidden.add(i)
		}
		ready.setHiddenParts(hidden)
	}, [ready, scene, hiddenParts])

	const highlight = useMemo(() => (scene && data ? pcbHighlight(scene, selection, data.compiled) : null), [scene, selection, data])
	// The selected net's name: a net, or the net of a selected track, via or pad.
	const selectedNet = useMemo(() => {
		if (!selection || !scene) return null
		if (selection.kind === "pcbObject") return scene.objects[selection.id]?.net ?? null
		return pcbNetName(selection, data?.compiled ?? null)
	}, [selection, scene, data])

	selectedNetRef.current = selectedNet
	// A new selection (or none) starts the highlight afresh.
	useEffect(() => setExtraNets([]), [selection])
	const extraIds = useMemo(() => (scene && extraNets.length ? scene.objects.filter(o => o.net && extraNets.includes(o.net)).map(o => o.id) : []), [scene, extraNets])

	// The labelled nets, each with the copper it is shown by: the selection's (a selected track: that
	// track), then the added ones.
	const labelled = useMemo(() => {
		if (!scene) return []
		const out: { net: string; ids: number[] }[] = []
		if (selectedNet && highlight) out.push({ net: selectedNet, ids: [...highlight.objects].filter(i => scene.objects[i]?.net === selectedNet) })
		for (const net of extraNets) out.push({ net, ids: extraIds.filter(i => scene.objects[i]!.net === net) })
		return out
	}, [scene, selectedNet, highlight, extraNets, extraIds])

	// Each frame: every label beside its point (above and to the right, turned the other way at the
	// canvas's edges, kept inside it). The hovered pad's stays on the pad, hidden while out of view. A
	// highlighted net's keeps its point on the net's copper while that stays in view, else moves to the
	// copper nearest the middle of the view (on the side looked at, if any is in view there), away from
	// the other labels.
	useLayoutEffect(() => {
		if (!ready) return
		type Box = { x: number; y: number; w: number; h: number }
		// Where a label goes for a point: above and to its right, turned the other way at the edges.
		const boxAt = (tag: HTMLDivElement, p: { x: number; y: number }): Box => {
			const w = ready.canvas.clientWidth, h = ready.canvas.clientHeight
			const tw = tag.offsetWidth, th = tag.offsetHeight
			let x = p.x + TAG_GAP, y = p.y - TAG_GAP - th
			if (x + tw > w - 4) x = p.x - TAG_GAP - tw
			if (y < 4) y = p.y + TAG_GAP
			return { x: Math.max(4, Math.min(w - tw - 4, x)), y: Math.max(4, Math.min(h - th - 4, y)), w: tw, h: th }
		}
		const put = (tag: HTMLDivElement, box: Box) => {
			tag.style.visibility = ""
			tag.classList.add("pinned")
			tag.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`
		}
		const nets = labelled.map(l => ({ net: l.net, anchors: ready.anchorsOf(l.ids), chosen: -1 }))
		const placeTags = () => {
			const w = ready.canvas.clientWidth, h = ready.canvas.clientHeight
			const inView = (p: { x: number; y: number } | null): p is { x: number; y: number } =>
				p !== null && p.x >= TAG_MARGIN && p.y >= TAG_MARGIN && p.x <= w - TAG_MARGIN && p.y <= h - TAG_MARGIN
			const hover = hoverTag.current
			if (hover) {
				const p = anchors.current.hover && ready.toCanvas(anchors.current.hover)
				if (p && p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h) put(hover, boxAt(hover, p))
				else hover.style.visibility = "hidden"
			}
			const facing = ready.facing()
			const seen = (side: string) => side === facing || side === "both"
			const taken: Box[] = []
			for (const n of nets) {
				const tag = netTags.current.get(n.net)
				if (!tag) continue
				const points = n.anchors.map(a => ready.toCanvas(a.point))
				const crowded = (p: { x: number; y: number }) => {
					const b = boxAt(tag, p)
					return taken.some(t => b.x < t.x + t.w + TAG_SPACE && t.x < b.x + b.w + TAG_SPACE && b.y < t.y + t.h + TAG_SPACE && t.y < b.y + b.h + TAG_SPACE)
				}
				const anySeen = n.anchors.some((a, i) => seen(a.side) && inView(points[i]!))
				const ok = (i: number) => inView(points[i]!) && (seen(n.anchors[i]!.side) || !anySeen)
				if (n.chosen < 0 || !ok(n.chosen) || crowded(points[n.chosen]!)) {
					let best = -1, bestScore = Infinity
					points.forEach((p, i) => {
						if (!p) return
						const score = Math.hypot(p.x - w / 2, p.y - h / 2) + (ok(i) ? 0 : 1e6) + (crowded(p) ? 1e4 : 0)
						if (score < bestScore) (best = i), (bestScore = score)
					})
					n.chosen = best
				}
				const p = n.chosen >= 0 ? points[n.chosen] : null
				if (!p) {
					tag.style.visibility = "hidden"
					continue
				}
				const box = boxAt(tag, p)
				put(tag, box)
				taken.push(box)
			}
		}
		placeTags()
		return ready.onRender(placeTags)
	}, [ready, hoverNet, labelled])
	const selectedComponents = useMemo(() => {
		if (!scene || !data || !selection) return null
		if (selection.kind === "pcbComponent") return new Set([selection.index])
		if (selection.kind === "component") {
			const i = pcbComponentIndex(scene, data.compiled, selection.id)
			return new Set(i >= 0 ? [i] : [])
		}
		// A measurement leaves the parts as they are; a net greys them.
		return selection.kind === "measure" ? null : new Set<number>()
	}, [scene, data, selection])

	// The ruler's canvas, redrawn with every frame of the board and whenever a measurement changes: each
	// measurement made here, the one being made, where the next click would land.
	engineRef.current = ready
	drawOverlay.current = () => {
		const cv = overlay.current
		const ctx = cv?.getContext("2d")
		if (!cv || !ctx) return
		const ratio = window.devicePixelRatio || 1
		const w = Math.round(cv.clientWidth * ratio), h = Math.round(cv.clientHeight * ratio)
		if (cv.width !== w || cv.height !== h) (cv.width = w), (cv.height = h)
		ctx.clearRect(0, 0, cv.width, cv.height)
		if (!ready) return
		const project = ready.canvasProjector(ratio)
		const sel = useAppStore.getState().selection
		const drawn: DrawnMeasure[] = []
		for (const m of useAppStore.getState().measures) {
			if (m.view !== "3d") continue
			const d = drawMeasure(ctx, m, project, ratio, sel?.kind === "measure" && sel.id === m.id ? "selected" : "idle")
			if (d) drawn.push(d)
		}
		drawnMeasures.current = drawn
		if (!measuringRef.current) return
		const live = tool.live
		if (live) drawMeasure(ctx, live, project, ratio, "live")
		const at = tool.cursor && project.point(tool.cursor)
		if (at && tool.cursor && tool.marking) drawSnapMarker(ctx, at, tool.cursor.snap, ratio, tool.cursor.target)
	}
	useEffect(() => {
		if (!ready) return
		drawOverlay.current()
		return ready.onRender(() => drawOverlay.current())
	}, [ready])
	const measureMode = useAppStore(s => s.measureMode)
	useEffect(() => {
		if (!measuring) tool.reset()
		else tool.refresh()
		drawOverlay.current()
	}, [measuring, measures, selection, tool, measureMode])

	useEffect(() => {
		ready?.setSelected(selectedComponents)
	}, [ready, selectedComponents])

	// The selection's copper, as real geometry from the worker: every layer, every hole. A net or one
	// board object shows over everything; a part's pads stay under its body.
	useEffect(() => {
		if (!ready) return
		const ids = new Set([...(highlight?.objects ?? []), ...extraIds])
		if (ids.size === 0) return ready.setHighlight(null, false)
		let live = true
		const overAll = extraIds.length > 0 || (selection !== null && selection.kind !== "component" && selection.kind !== "pcbComponent")
		const started = performance.now()
		loaded!.highlight([...ids]).then(meshes => {
			if (!live) return
			ready.setHighlight(meshes, overAll)
			ready.timing.highlight = performance.now() - started
		})
		return () => {
			live = false
		}
	}, [ready, highlight, selection, loaded, extraIds])

	// Framing requests (the inspector's 3D button, a net from the tree): look straight at it, from the
	// side it is on (a bottom-side part from below); something on both sides, from the side shown.
	useEffect(() => {
		if (pane.diff || !ready || !scene || !highlight || focusSeq === consumedFocus) return
		consumedFocus = focusSeq
		if (!highlight.frame) return
		const [x0, y0, x1, y1] = highlight.frame
		const pad = Math.max(x1 - x0, y1 - y0) * 0.1 + 40
		ready.setView(ready.fitView([x0 - pad, y0 - pad, x1 + pad, y1 + pad], selectionSide(scene, selection, data?.compiled ?? null, highlight.objects) ?? objects.side ?? "top"))
	}, [ready, scene, highlight, focusSeq, objects.side, selection, data])

	useEffect(() => {
		ready?.setActive(active)
		if (!active) return
		const key = (e: KeyboardEvent) => {
			if ((e.target as Element | null)?.closest?.("input, textarea, select, [contenteditable]")) return
			if (measureKey(e, tool)) return
			if (e.key === "Escape") useAppStore.getState().select(null)
			if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
			// Shift+S: the layer mode (all, highlight current, current only).
			if (e.code === "KeyS" && e.shiftKey) {
				e.preventDefault()
				return setLayerView(v => ({ ...v, mode: LAYER_MODES[(LAYER_MODES.indexOf(v.mode) + 1) % LAYER_MODES.length]! }))
			}
			if (e.shiftKey) return
			// F turns the board over about the cursor.
			if (e.code === "KeyF") {
				e.preventDefault()
				ready?.flip()
			}
			// Z hides every part's 3D body, or shows them again (the Objects panel's 3D Body row).
			if (e.code === "KeyZ") {
				e.preventDefault()
				setObjects(o => {
					const hiddenKinds = new Set(o.hiddenKinds)
					if (hiddenKinds.has("body")) hiddenKinds.delete("body")
					else hiddenKinds.add("body")
					return { ...o, hiddenKinds }
				})
			}
		}
		window.addEventListener("keydown", key)
		return () => window.removeEventListener("keydown", key)
	}, [active, ready])

	const status = ready ? "ready" : loaded === null ? "none" : "loading"
	return (
		<div className={`view3d${measuring ? " measuring" : ""}`} data-status={status}>
			{/* Hidden until ready, then left to inherit: "visible" here would show it through the home screen
			    while the viewer is parked behind it (visibility: hidden on the host). */}
			<canvas ref={canvas} className="view3d-canvas" style={{ visibility: ready ? undefined : "hidden" }} />
			<canvas ref={overlay} className="measure-overlay" aria-hidden="true" />
			{ready && measuring && <MeasureBar view="3d" />}
			{ready && measuring && <MeasureLegend />}
			{status === "loading" && (
				<div className="view3d-loading" role="status">
					<div className="view3d-spinner" />
					<div>Loading 3D model…</div>
					{progress.total > 0 && (
						<div className="view3d-loading-count">
							{progress.done} / {progress.total} part models
						</div>
					)}
				</div>
			)}
			{status === "none" && <div className="view-message">This project has no board</div>}
			{ready && <ProjectionToggle value={projection} shifted={panelOpen} />}
			{ready && <ViewCube engine={ready} />}
			{ready && (layerView.mode !== "all" || layerNote > 0) && (
				<div className={`view3d-layer-badge${measuring ? " raised" : ""}`} role="status" data-layer={layerView.current} data-mode={layerView.mode}>
					<i style={{ background: scene?.layers.find(l => l.key === layerView.current)?.color }} />
					{scene?.layers.find(l => l.key === layerView.current)?.name ?? layerView.current}
					{layerView.mode !== "all" && <span> · {MODE_NAMES[layerView.mode]}</span>}
				</div>
			)}
			{ready &&
				labelled.map(l => (
					<div
						key={l.net}
						ref={el => void (el ? netTags.current.set(l.net, el) : netTags.current.delete(l.net))}
						className="view3d-net-tag"
						style={{ visibility: "hidden" }}
						role="status"
						aria-label="Highlighted net"
					>
						{l.net}
					</div>
				))}
			{ready && hoverNet && !labelled.some(l => l.net === hoverNet) && (
				<div ref={hoverTag} className="view3d-net-tag" role="status" aria-label="Hovered net">
					{hoverNet}
				</div>
			)}
			{ready && hiddenParts.size > 0 && (
				<button className="pcb-mirror-badge" onClick={() => useAppStore.getState().setView3dPanelOpen(true)}>
					<EyeOff size={14} />
					{hiddenParts.size} {hiddenParts.size === 1 ? "part" : "parts"} hidden
				</button>
			)}
			{ready && panelOpen && (
				<ObjectsPanel
					state={objects}
					onSide={side => {
						ready.showSide(side)
						setObjects({ ...objects, side })
					}}
					onKinds={hiddenKinds => setObjects({ ...objects, hiddenKinds })}
					onReset={() => setObjects({ ...objects, hiddenKinds: new Set(HIDDEN_3D_BY_DEFAULT) })}
					hiddenParts={hiddenParts}
					selectedPart={scene && selectedComponents?.size === 1 ? partKey(scene, [...selectedComponents][0]!) : null}
					partLabel={key => (scene ? partLabel(scene, partIndex(scene, key), data?.compiled ?? null) : key)}
					onHiddenParts={hidden => useAppStore.getState().setView3dHidden(hidden)}
					onSelectPart={key => {
						if (!scene || link.current) return
						const i = partIndex(scene, key)
						if (i >= 0) useAppStore.getState().select(componentSelection(scene, i, data?.compiled ?? null))
					}}
					onClose={() => useAppStore.getState().setView3dPanelOpen(false)}
				/>
			)}
		</div>
	)
}

// Perspective / Orthographic, a two-way slider over the top left of the canvas (beside the Objects
// panel when that is open).
const PROJECTIONS: { id: Projection3d; label: string }[] = [
	{ id: "perspective", label: "Perspective" },
	{ id: "orthographic", label: "Orthographic" },
]

function ProjectionToggle({ value, shifted }: { value: Projection3d; shifted: boolean }) {
	const set = useAppStore.getState().setView3dProjection
	return (
		<div className={`projection-toggle${shifted ? " shifted" : ""}`} role="radiogroup" aria-label="Projection" data-value={value}>
			<span className="projection-thumb" aria-hidden="true" />
			{PROJECTIONS.map(p => (
				<button key={p.id} role="radio" aria-checked={value === p.id} onClick={() => set(p.id)}>
					{p.label}
				</button>
			))}
		</div>
	)
}
