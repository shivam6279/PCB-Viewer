import { useEffect, useMemo, useRef, useState } from "react"
import { useAppStore } from "../app/store"
import { usePane, usePaneData, usePaneSelection, type ViewLink } from "../app/pane"
import type { Parser } from "../parse/parser"
import { componentSelection, pcbComponentIndex, pcbHighlight } from "../pcb/selection"
import type { PcbScene } from "../pcb/scene"
import { BoardEngine, type CameraState } from "./engine"
import { ObjectsPanel, type Objects3dState } from "./ObjectsPanel"
import { load3d, type Loaded3d } from "./prefetch"

// The camera and Objects settings per board, kept with the board.
const savedViews = new WeakMap<PcbScene, { camera: CameraState | null; objects: Objects3dState }>()
let consumedFocus = 0

const defaultObjects = (): Objects3dState => ({ side: null, hiddenKinds: new Set() })

// The 3D tab. It stays mounted once opened (tab switches only hide it), so coming back is instant.
export function View3d({ parser, active, readBoard }: { parser: Parser; active: boolean; readBoard(): Promise<Uint8Array> }) {
	const pane = usePane()
	const projectData = usePaneData()
	const selection = usePaneSelection()
	const focusSeq = useAppStore(s => s.view3dFocusSeq)
	const link = useRef<ViewLink<CameraState> | null>(null)
	link.current = (pane.links?.view3d as ViewLink<CameraState> | undefined) ?? null
	const panelOpen = useAppStore(s => s.view3dPanelOpen)
	const data = projectData.status === "ready" ? projectData.data : null
	const canvas = useRef<HTMLCanvasElement>(null)
	const [loaded, setLoaded] = useState<Loaded3d | null | undefined>(undefined)
	const [ready, setReady] = useState<BoardEngine | null>(null)
	const [objects, setObjects] = useState<Objects3dState>(defaultObjects)
	const [progress, setProgress] = useState({ done: 0, total: 0 })
	const scene = loaded?.scene ?? null

	// Everything is fetched (usually already, in the background) before anything is shown.
	useEffect(() => {
		if (!data) return
		if (!data.pcb) return setLoaded(null)
		const load = load3d(parser, data, readBoard, pane.side)
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

	// One engine per board, built with every part in place, its shaders compiled before it is shown.
	useEffect(() => {
		const el = canvas.current
		if (!el || !loaded) return
		const { scene, board, geometry, models } = loaded
		const saved = savedViews.get(scene)
		const me = {}
		const shared = link.current
		const e = new BoardEngine(el, scene, board, geometry, {
			pick: hit => {
				if (shared) return // side by side: no selection (ids differ between the commits)
				const state = useAppStore.getState()
				const compiled = state.projectData.status === "ready" ? state.projectData.data.compiled : null
				if (!hit) return state.select(null)
				state.select(hit.kind === "component" ? componentSelection(scene, hit.index, compiled) : { kind: "pcbObject", id: hit.id })
			},
			changed: () => {
				const entry = savedViews.get(scene)
				if (entry) entry.camera = e.getView()
				shared?.publish(e.getView(), me)
			},
		})
		const unlink = shared?.subscribe((v, from) => from !== me && e.setView(v))
		;(el as HTMLCanvasElement & { __view3d?: BoardEngine }).__view3d = e
		for (const [key, mesh] of models) e.setModel(key, mesh)
		if (shared?.last) e.setView(shared.last.value)
		else if (saved?.camera) e.setView(saved.camera)
		setObjects(saved?.objects ?? defaultObjects())
		if (!saved) savedViews.set(scene, { camera: null, objects: defaultObjects() })
		const observer = new ResizeObserver(() => e.resize())
		observer.observe(el)
		e.warmUp()
		setReady(e)
		return () => {
			unlink?.()
			observer.disconnect()
			e.dispose()
			setReady(null)
		}
	}, [loaded])

	useEffect(() => {
		if (!scene) return
		const entry = savedViews.get(scene)
		if (entry) entry.objects = objects
	}, [scene, objects])

	useEffect(() => {
		ready?.setHiddenKinds(objects.hiddenKinds)
	}, [ready, objects.hiddenKinds])

	const highlight = useMemo(() => (scene && data ? pcbHighlight(scene, selection, data.compiled) : null), [scene, selection, data])
	const selectedComponents = useMemo(() => {
		if (!scene || !data || !selection) return null
		if (selection.kind === "pcbComponent") return new Set([selection.index])
		if (selection.kind === "component") {
			const i = pcbComponentIndex(scene, data.compiled, selection.id)
			return new Set(i >= 0 ? [i] : [])
		}
		return new Set<number>()
	}, [scene, data, selection])

	useEffect(() => {
		ready?.setSelected(selectedComponents)
	}, [ready, selectedComponents])

	// The selection's copper, as real geometry from the worker: every layer, every hole. A net or one
	// board object shows over everything; a part's pads stay under its body.
	useEffect(() => {
		if (!ready) return
		if (!highlight || highlight.objects.size === 0) return ready.setHighlight(null, false)
		let live = true
		const overAll = selection !== null && selection.kind !== "component" && selection.kind !== "pcbComponent"
		const started = performance.now()
		loaded!.highlight([...highlight.objects]).then(meshes => {
			if (!live) return
			ready.setHighlight(meshes, overAll)
			ready.timing.highlight = performance.now() - started
		})
		return () => {
			live = false
		}
	}, [ready, highlight, selection, loaded])

	// Framing requests (the inspector's 3D button, a net from the tree): look straight down on it.
	useEffect(() => {
		if (pane.diff || !ready || !highlight || focusSeq === consumedFocus) return
		consumedFocus = focusSeq
		if (!highlight.frame) return
		const [x0, y0, x1, y1] = highlight.frame
		const pad = Math.max(x1 - x0, y1 - y0) * 0.1 + 40
		ready.setView(ready.fitView([x0 - pad, y0 - pad, x1 + pad, y1 + pad], objects.side ?? "top"))
	}, [ready, highlight, focusSeq, objects.side])

	useEffect(() => {
		ready?.setActive(active)
		if (!active) return
		const key = (e: KeyboardEvent) => {
			if (e.key === "Escape") useAppStore.getState().select(null)
		}
		window.addEventListener("keydown", key)
		return () => window.removeEventListener("keydown", key)
	}, [active, ready])

	const status = ready ? "ready" : loaded === null ? "none" : "loading"
	return (
		<div className="view3d" data-status={status}>
			<canvas ref={canvas} className="view3d-canvas" style={{ visibility: ready ? "visible" : "hidden" }} />
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
			{ready && panelOpen && (
				<ObjectsPanel
					state={objects}
					onSide={side => {
						ready.showSide(side)
						setObjects({ ...objects, side })
					}}
					onKinds={hiddenKinds => setObjects({ ...objects, hiddenKinds })}
					onReset={() => setObjects({ ...objects, hiddenKinds: new Set() })}
					onClose={() => useAppStore.getState().setView3dPanelOpen(false)}
				/>
			)}
		</div>
	)
}
