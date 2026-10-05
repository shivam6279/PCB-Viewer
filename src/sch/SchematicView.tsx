import { useEffect, useRef, useState } from "react"
import { useAppStore } from "../app/store"
import { usePane, usePaneData, usePaneSelection, type ViewLink } from "../app/pane"
import { channelOf, flattenHierarchy, type Channel, type HierarchyNode } from "../model/hierarchy"
import type { ProjectSummary } from "../model/load-project"
import type { Parser } from "../parse/parser"
import { basename } from "../source/paths"
import type { ProjectSource } from "../source/types"
import { buildPortMenu, classifyClick, jumpObjects, type ClickAction, type MenuNode } from "./interaction"
import { PortMenu } from "./PortMenu"
import { prepareSheetSvg } from "./prepare-svg"
import { createScene, frameObjects, hitTest, paintOverlay, type Scene } from "./sheet-scene"
import { fitView, panBy, zoomAt, type Size, type ViewBox } from "./viewport"

type Prepared = ReturnType<typeof prepareSheetSvg>
type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; sheet: Prepared }

// Rendered sheet instances per source (a sheet differs per REPEAT channel), so flipping back is instant.
const cache = new WeakMap<ProjectSource, Map<string, Promise<Prepared>>>()

export function loadSheet(source: ProjectSource, project: ProjectSummary, docPath: string, channel: Channel | null, parser: Parser): Promise<Prepared> {
	let perSource = cache.get(source)
	if (!perSource) cache.set(source, (perSource = new Map()))
	const key = channel ? `${docPath}#${channel.name}` : docPath
	let pending = perSource.get(key)
	if (!pending) {
		pending = (async () => {
			const [bytes, projectBytes] = await Promise.all([source.read(docPath), project.prjPath ? source.read(project.prjPath) : null])
			const svg = await parser.renderSheetSvg(bytes, {
				documentName: basename(docPath),
				projectBytes,
				projectName: project.prjPath ? basename(project.prjPath) : null,
				channel,
			})
			return prepareSheetSvg(svg)
		})()
		pending.catch(() => perSource!.delete(key)) // let a retry happen after a failure
		perSource.set(key, pending)
	}
	return pending
}

interface MenuState {
	x: number
	y: number
	area: { left: number; top: number; width: number; height: number } // the view on the page, for the menu (a body portal)
	netId: number
	items: MenuNode[]
}

const CLICK_SLOP = 4 // px a press may move and still count as a click rather than a pan

export function SchematicView({ source, project, node, parser }: {
	source: ProjectSource
	project: ProjectSummary
	node: HierarchyNode
	parser: Parser
}) {
	const [state, setState] = useState<LoadState>({ status: "loading" })
	const [hover, setHover] = useState<ClickAction | null>(null)
	const [menu, setMenu] = useState<MenuState | null>(null)
	const frame = useRef<HTMLDivElement>(null)
	const host = useRef<HTMLDivElement>(null)
	const view = useRef<ViewBox | null>(null)
	const scene = useRef<Scene | null>(null)
	const frameView = useRef<((v: ViewBox) => void) | null>(null)
	const pane = usePane()
	const projectData = usePaneData()
	const selection = usePaneSelection()
	const storeFocus = useAppStore(s => s.focus)
	const focus = pane.diff ? null : storeFocus
	const link = pane.links?.sch as ViewLink<ViewBox> | undefined
	const mark = pane.mark
	const data = projectData.status === "ready" ? projectData.data : null
	const docPath = node.docPath
	const channel = channelOf(project.hierarchy, node.id)
	const channelName = channel?.name ?? null

	useEffect(() => {
		if (!docPath) {
			setState({ status: "error", message: `Sheet file not found: ${node.fileName}` })
			return
		}
		let current = true
		setState({ status: "loading" })
		loadSheet(source, project, docPath, channelName === null ? null : channelOf(project.hierarchy, node.id), parser).then(
			sheet => current && setState({ status: "ready", sheet }),
			e => current && setState({ status: "error", message: e instanceof Error ? e.message : String(e) }),
		)
		return () => {
			current = false
		}
	}, [source, project, docPath, channelName, node.id, node.fileName, parser])

	// Pointer handlers are bound once per mounted sheet; these refs give them the current render's view.
	const actionAt = (x: number, y: number): ClickAction | null => {
		const sc = scene.current
		if (!sc || !data) return null
		const hit = hitTest(sc, x, y)
		return hit ? classifyClick(hit, node, docPath ? data.sheets[docPath] : undefined, data.compiled) : null
	}
	const handlers = useRef({ click: (_x: number, _y: number) => {}, hover: (_x: number, _y: number) => {} })
	handlers.current.click = (x, y) => {
		const { select, selectSheet } = useAppStore.getState()
		const action = actionAt(x, y)
		setMenu(null)
		if (!action) return select(null)
		if (action.kind === "net") return select({ kind: "net", netId: action.netId })
		if (action.kind === "component") return select({ kind: "component", id: action.id })
		if (action.kind === "symbol") return selectSheet(action.childId)
		const net = data!.compiled.nets[action.netId]!
		const r = frame.current!.getBoundingClientRect()
		select({ kind: "net", netId: action.netId })
		setMenu({ x: x - r.left, y: y - r.top, area: { left: r.left, top: r.top, width: r.width, height: r.height }, netId: action.netId, items: buildPortMenu(project.hierarchy, net, node.id) })
	}
	handlers.current.hover = (x, y) => {
		const action = actionAt(x, y)
		setHover(prev => (JSON.stringify(prev) === JSON.stringify(action) ? prev : action))
	}

	// Mount the SVG and wire pan/zoom/click whenever a sheet becomes ready.
	useEffect(() => {
		if (state.status !== "ready" || !frame.current || !host.current) return
		const frameEl = frame.current
		host.current.innerHTML = state.sheet.markup
		const svg = host.current.querySelector("svg")
		if (!svg) return
		svg.setAttribute("preserveAspectRatio", "xMidYMid meet")
		scene.current = createScene(svg as SVGSVGElement)

		const size = (): Size => ({ width: frameEl.clientWidth || 1, height: frameEl.clientHeight || 1 })
		// Side by side, the other pane follows this one's view (and this one follows it).
		const me = {}
		const show = (v: ViewBox) => {
			view.current = v
			svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`)
		}
		const apply = (v: ViewBox) => {
			show(v)
			link?.publish(v, me)
		}
		const unlink = link?.subscribe((v, from) => from !== me && show(v))
		frameView.current = v => apply(fitView(v, size(), 0))
		const fit = () => apply(fitView(state.sheet.viewBox, size()))
		const limits = { minW: state.sheet.viewBox.w / 200, maxW: state.sheet.viewBox.w * 10 }
		if (link?.last) show(link.last.value)
		else fit()

		// The port menu floats inside the frame; its own pointer events are not the canvas's.
		const inMenu = (e: Event) => (e.target as Element | null)?.closest?.(".port-menu") != null
		const onWheel = (e: WheelEvent) => {
			if (inMenu(e)) return
			e.preventDefault()
			const r = frameEl.getBoundingClientRect()
			apply(zoomAt(view.current!, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, size(), limits))
		}
		let drag: { x: number; y: number; startX: number; startY: number; moved: boolean; button: number } | null = null
		const onDown = (e: PointerEvent) => {
			if ((e.button !== 0 && e.button !== 1 && e.button !== 2) || inMenu(e)) return
			drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, button: e.button }
			frameEl.setPointerCapture?.(e.pointerId)
		}
		const onMove = (e: PointerEvent) => {
			if (!drag) {
				if (inMenu(e)) return
				handlers.current.hover(e.clientX, e.clientY)
				return
			}
			if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < CLICK_SLOP) return
			if (!drag.moved) {
				drag.moved = true
				frameEl.classList.add("panning")
				setMenu(null)
			}
			apply(panBy(view.current!, e.clientX - drag.x, e.clientY - drag.y, size()))
			drag.x = e.clientX
			drag.y = e.clientY
		}
		const onUp = (e: PointerEvent) => {
			const click = drag !== null && !drag.moved && drag.button === 0 && e.type === "pointerup"
			drag = null
			frameEl.classList.remove("panning")
			if (click) handlers.current.click(e.clientX, e.clientY)
		}
		const onLeave = () => setHover(null)
		const onMenu = (e: Event) => e.preventDefault()
		// Keep the zoom when the panel resizes; only the view's aspect follows the frame.
		const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
			const v = view.current
			if (!v || frameEl.clientWidth === 0) return // hidden while another tab shows
			const s = size()
			const h = v.w * (s.height / s.width)
			apply({ x: v.x, y: v.y + (v.h - h) / 2, w: v.w, h })
		})

		frameEl.addEventListener("wheel", onWheel, { passive: false })
		frameEl.addEventListener("pointerdown", onDown)
		frameEl.addEventListener("pointermove", onMove)
		frameEl.addEventListener("pointerup", onUp)
		frameEl.addEventListener("pointercancel", onUp)
		frameEl.addEventListener("pointerleave", onLeave)
		frameEl.addEventListener("contextmenu", onMenu)
		resize?.observe(frameEl)
		return () => {
			scene.current = null
			frameView.current = null
			frameEl.removeEventListener("wheel", onWheel)
			frameEl.removeEventListener("pointerdown", onDown)
			frameEl.removeEventListener("pointermove", onMove)
			frameEl.removeEventListener("pointerup", onUp)
			frameEl.removeEventListener("pointercancel", onUp)
			frameEl.removeEventListener("pointerleave", onLeave)
			frameEl.removeEventListener("contextmenu", onMenu)
			resize?.disconnect()
			unlink?.()
		}
	}, [state])

	// Net colours from the compiled project: the renderer only knows the names on this sheet, so a colour
	// set on 12V would miss the same net called V_GATE_DRIVE here. Replace its bands with the compiled ones.
	useEffect(() => {
		const sc = scene.current
		const colors = data?.wireColors[node.id]
		if (!sc || state.status !== "ready" || !colors) return
		for (const el of [...sc.content.querySelectorAll("[data-net-color]")]) el.remove()
		const bands = document.createDocumentFragment()
		for (const [i, color] of Object.entries(colors)) {
			const g = sc.byIndex.get(Number(i))
			for (const line of g?.querySelectorAll("polyline:not(.hit)") ?? []) {
				const band = line.cloneNode(false) as SVGElement
				band.removeAttribute("data-record")
				band.setAttribute("data-net-color", "")
				band.setAttribute("stroke", color)
				band.setAttribute("stroke-width", "5.1")
				bands.appendChild(band)
			}
		}
		sc.content.insertBefore(bands, sc.content.firstChild)
	}, [state, data, node.id])

	// Hover and selection overlay.
	useEffect(() => {
		const sc = scene.current
		if (!sc || state.status !== "ready") return
		const netObjects = (netId: number) => data?.compiled.nets[netId]?.occurrences.find(o => o.instanceId === node.id)?.objects ?? null
		const ownerOf = (id: string) => {
			const c = data?.compiled.components.find(c => c.id === id)
			return c && c.instanceId === node.id ? c.i : null
		}
		paintOverlay(sc, {
			selectedNet: selection?.kind === "net" ? netObjects(selection.netId) : null,
			selectedOwner: selection?.kind === "component" ? ownerOf(selection.id) : null,
			hoverNet: hover?.kind === "net" || hover?.kind === "port" ? netObjects(hover.netId) : null,
			hoverOwner: hover?.kind === "component" ? ownerOf(hover.id) : hover?.kind === "symbol" ? hover.symbolI : null,
			diff: mark && !mark.mostly ? { indices: [...mark.ids], tone: mark.tone } : null,
		})
		frame.current?.classList.toggle("pointing", hover !== null)
	}, [state, data, selection, hover, node.id, mark])

	// Frame the objects a jump asked for once this sheet is on screen.
	useEffect(() => {
		const sc = scene.current
		if (!sc || state.status !== "ready" || !focus || focus.instanceId !== node.id) return
		const v = frameObjects(sc, focus.objects, state.sheet.viewBox.w / 6)
		if (v) frameView.current?.(v)
	}, [state, focus, node.id])

	const jump = (instanceId: string) => {
		setMenu(null)
		if (!data || !menu) return
		const target = flattenHierarchy(project.hierarchy).find(n => n.id === instanceId)
		const net = data.compiled.nets[menu.netId]!
		const sheet = target?.docPath ? data.sheets[target.docPath] : undefined
		useAppStore.getState().jumpTo(instanceId, jumpObjects(net, instanceId, sheet), { kind: "net", netId: menu.netId })
	}

	return (
		<div className="sch-view" ref={frame} data-status={state.status} data-node={node.id} data-compiled={data ? "true" : "false"}>
			<div className="sch-host" ref={host} />
			{state.status === "loading" && <div className="view-message">Loading {node.label}…</div>}
			{state.status === "error" && <div className="view-message error">{state.message}</div>}
			{menu && <PortMenu x={menu.x} y={menu.y} area={menu.area} items={menu.items} onPick={jump} onClose={() => setMenu(null)} />}
		</div>
	)
}
