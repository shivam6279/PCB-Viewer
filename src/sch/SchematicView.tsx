import { useCallback, useEffect, useRef, useState } from "react"
import { GitCommitSource } from "../github/commit-source"
import { useAppStore, type Selection } from "../app/store"
import { usePane, usePaneData, usePaneSelection, type ViewLink } from "../app/pane"
import { channelOf, flattenHierarchy, type Channel, type HierarchyNode } from "../model/hierarchy"
import type { ProjectSummary } from "../model/load-project"
import type { Parser } from "../parse/parser"
import { basename } from "../source/paths"
import type { ProjectSource } from "../source/types"
import { buildPortMenu, classifyClick, highlightObjects, jumpObjects, type ClickAction, type MenuNode } from "./interaction"
import { PortMenu, type PopupArea } from "./PortMenu"
import { PartCard } from "./PartCard"
import { prepareSheetSvg } from "./prepare-svg"
import { writeDesignators, writeNetColors, writeNetNames } from "./sheet-text"
import { createScene, frameObjects, hitTest, markNotFitted, paintOverlay, type Scene } from "./sheet-scene"
import { notFittedPaths } from "../model/variants"
import { fitView, panBy, zoomAt, type Size, type ViewBox } from "./viewport"

type Prepared = ReturnType<typeof prepareSheetSvg>
type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; sheet: Prepared }

// Rendered sheet instances per source (a sheet differs per REPEAT channel), so flipping back is instant.
const cache = new WeakMap<ProjectSource, Map<string, Promise<Prepared>>>()

export function loadSheet(source: ProjectSource, project: ProjectSummary, docPath: string, channel: Channel | null, parser: Parser): Promise<Prepared> {
	let perSource = cache.get(source)
	if (!perSource) cache.set(source, (perSource = new Map()))
	// Title blocks show the variant shown (=VariantName) and the commit (=VersionControl_RevNumber).
	const variantName = useAppStore.getState().variant
	const parameters: Record<string, string> = {
		VersionControl_RevNumber: source instanceof GitCommitSource ? source.sha.slice(0, 7) : "",
		VersionControl_ProjFolderRevNumber: source instanceof GitCommitSource ? source.sha.slice(0, 7) : "",
		ModifiedDate: "", // not known here: left blank rather than shown as the raw =ModifiedDate
	}
	const key = `${channel ? `${docPath}#${channel.name}` : docPath}|${variantName ?? ""}`
	let pending = perSource.get(key)
	if (!pending) {
		pending = (async () => {
			const [bytes, projectBytes] = await Promise.all([source.read(docPath), project.prjPath ? source.read(project.prjPath) : null])
			const svg = await parser.renderSheetSvg(bytes, {
				documentName: basename(docPath),
				projectBytes,
				projectName: project.prjPath ? basename(project.prjPath) : null,
				channel,
				variantName,
				parameters,
			})
			return prepareSheetSvg(svg)
		})()
		pending.catch(() => perSource!.delete(key)) // let a retry happen after a failure
		perSource.set(key, pending)
	}
	return pending
}

// A popup at the cursor: the sheets a net reaches (click on a net, port or entry), or a part's card
// (right-click on a part).
type MenuState = {
	x: number
	y: number
	area: PopupArea // the view on the page, for the popup (a body portal)
} & ({ kind: "sheets"; netId: number; items: MenuNode[] } | { kind: "part"; componentId: string })

const CLICK_SLOP = 4 // px a press may move and still count as a click rather than a pan

// The last sheet file shown and its view: going from one channel of a sheet to another keeps the view.
let lastShown: { source: ProjectSource; docPath: string; view: ViewBox } | null = null

export function SchematicView({ source, project, node, parser }: {
	source: ProjectSource
	project: ProjectSummary
	node: HierarchyNode
	parser: Parser
}) {
	const [state, setState] = useState<LoadState>({ status: "loading" })
	const [hover, setHover] = useState<ClickAction | null>(null)
	const [menu, setMenu] = useState<MenuState | null>(null)
	const [tip, setTip] = useState<{ x: number; y: number; names: string[] } | null>(null)
	const frame = useRef<HTMLDivElement>(null)
	const host = useRef<HTMLDivElement>(null)
	const view = useRef<ViewBox | null>(null)
	const scene = useRef<Scene | null>(null)
	const frameView = useRef<((v: ViewBox) => void) | null>(null)
	const pane = usePane()
	const projectData = usePaneData()
	const selection = usePaneSelection()
	const storeFocus = useAppStore(s => s.focus)
	const variant = useAppStore(s => s.variant)
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
	}, [source, project, docPath, channelName, node.id, node.fileName, parser, variant])

	// Pointer handlers are bound once per mounted sheet; these refs give them the current render's view.
	const actionAt = (x: number, y: number): ClickAction | null => {
		const sc = scene.current
		if (!sc || !data) return null
		const hit = hitTest(sc, x, y)
		return hit ? classifyClick(hit, node, docPath ? data.sheets[docPath] : undefined, data.compiled) : null
	}
	const handlers = useRef({ click: (_x: number, _y: number) => {}, context: (_x: number, _y: number) => {}, hover: (_x: number, _y: number) => {} })
	const popupAt = (x: number, y: number) => {
		const r = frame.current!.getBoundingClientRect()
		return { x: x - r.left, y: y - r.top, area: { left: r.left, top: r.top, width: r.width, height: r.height } }
	}
	const sheetsMenu = (x: number, y: number, netId: number) => {
		const net = data!.compiled.nets[netId]!
		useAppStore.getState().select({ kind: "net", netId })
		setMenu({ ...popupAt(x, y), kind: "sheets", netId, items: buildPortMenu(project.hierarchy, net, node.id) })
	}
	handlers.current.click = (x, y) => {
		const { select, selectSheet } = useAppStore.getState()
		const action = actionAt(x, y)
		setMenu(null)
		if (!action) return select(null)
		if (action.kind === "bundle") return select({ kind: "bundle", bundleId: action.bundleId })
		if (action.kind === "component") return select({ kind: "component", id: action.id })
		if (action.kind === "symbol") return selectSheet(action.childId)
		// A port or sheet entry: the sheets its net is on. A wire, label or pin selects the net.
		if (action.kind === "port") sheetsMenu(x, y, action.netId)
		else select({ kind: "net", netId: action.netId })
	}
	handlers.current.context = (x, y) => {
		const action = actionAt(x, y)
		setMenu(null)
		if (action?.kind === "component") {
			useAppStore.getState().select({ kind: "component", id: action.id })
			setMenu({ ...popupAt(x, y), kind: "part", componentId: action.id })
		} else if (action?.kind === "net" || action?.kind === "port") sheetsMenu(x, y, action.netId)
	}
	handlers.current.hover = (x, y) => {
		const action = actionAt(x, y)
		setHover(prev => (JSON.stringify(prev) === JSON.stringify(action) ? prev : action))
		// A net called something else on this sheet than its physical name: the local name(s) as a tooltip.
		const net = action && (action.kind === "net" || action.kind === "port") ? data?.compiled.nets[action.netId] : undefined
		const names = net?.aliases.filter(a => a.instanceIds.includes(node.id)).map(a => a.name) ?? []
		const r = frame.current?.getBoundingClientRect()
		setTip(names.length > 0 && r ? { x: x - r.left, y: y - r.top, names } : null)
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
			if (!link && docPath) lastShown = { source, docPath, view: v }
			svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`)
			// Sheet units per screen pixel ("meet" fit): CSS widths in sheet units with a screen-pixel floor.
			const s = size()
			svg.style.setProperty("--upx", String(Math.max(v.w / s.width, v.h / s.height)))
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
		else if (!link && lastShown && lastShown.source === source && lastShown.docPath === docPath) show(lastShown.view)
		else fit()

		// The port menu floats inside the frame; its own pointer events are not the canvas's.
		const inMenu = (e: Event) => (e.target as Element | null)?.closest?.(".sch-popup") != null
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
				setTip(null)
			}
			apply(panBy(view.current!, e.clientX - drag.x, e.clientY - drag.y, size()))
			drag.x = e.clientX
			drag.y = e.clientY
		}
		const onUp = (e: PointerEvent) => {
			const click = drag !== null && !drag.moved && e.type === "pointerup" ? drag.button : null
			drag = null
			frameEl.classList.remove("panning")
			if (click === 0) handlers.current.click(e.clientX, e.clientY)
			if (click === 2) handlers.current.context(e.clientX, e.clientY)
		}
		const onLeave = () => {
			setHover(null)
			setTip(null)
		}
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
		writeNetColors(sc.content, colors)
	}, [state, data, node.id])

	// Physical designators: one drawing serves every channel of a sheet, and its designators are the
	// sheet's own (TVS1); this instance's parts are named as compiled (TVS1_CAN1, the board's).
	useEffect(() => {
		const sc = scene.current
		if (!sc || state.status !== "ready" || !data) return
		writeDesignators(sc.content, data.compiled, node.id)
	}, [state, data, node.id])

	// Net labels and power ports name the net by its physical name; the one written on this sheet, if
	// different, shows as a tooltip on hover.
	useEffect(() => {
		const sc = scene.current
		if (!sc || state.status !== "ready" || !data) return
		writeNetNames(sc.content, data.compiled, node.id)
	}, [state, data, node.id])

	// The shown variant's not-fitted parts: greyed, with a red cross over the body.
	useEffect(() => {
		const sc = scene.current
		if (!sc || state.status !== "ready") return
		const off = notFittedPaths(project.variants, variant)
		const owners = off.size === 0 ? [] : (data?.compiled.components ?? []).filter(c => c.instanceId === node.id && off.has(c.uniquePath.toUpperCase())).map(c => c.i)
		markNotFitted(sc, owners)
		frame.current?.setAttribute("data-not-fitted", String(owners.length))
	}, [state, data, project.variants, variant, node.id])

	// Hover and selection overlay.
	useEffect(() => {
		const sc = scene.current
		if (!sc || state.status !== "ready") return
		const lit = (t: Selection | ClickAction | null) => {
			if (!data || !t) return null
			if (t.kind === "net" || t.kind === "port") return highlightObjects(data.compiled, node.id, { kind: "net", netId: t.netId })
			if (t.kind === "bundle") return highlightObjects(data.compiled, node.id, t)
			return null
		}
		const selected = lit(selection)
		// Hovering what is already selected adds nothing over the selection.
		const hoverIsSelection = JSON.stringify(hover && (hover.kind === "port" ? { kind: "net", netId: hover.netId } : hover)) === JSON.stringify(selection)
		const ownerOf = (id: string) => {
			const c = data?.compiled.components.find(c => c.id === id)
			return c && c.instanceId === node.id ? c.i : null
		}
		paintOverlay(sc, {
			selectedNet: selected,
			selectedOwner: selection?.kind === "component" ? ownerOf(selection.id) : null,
			hoverNet: hoverIsSelection ? null : lit(hover),
			hoverOwner: hover?.kind === "component" ? ownerOf(hover.id) : hover?.kind === "symbol" ? hover.symbolI : null,
			diff: mark && !mark.mostly ? { indices: [...mark.ids], ghosts: mark.ghosts, moves: mark.moves ?? [], dim: mark.dim } : null,
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
		if (!data || menu?.kind !== "sheets") return
		const target = flattenHierarchy(project.hierarchy).find(n => n.id === instanceId)
		const net = data.compiled.nets[menu.netId]!
		const sheet = target?.docPath ? data.sheets[target.docPath] : undefined
		useAppStore.getState().jumpTo(instanceId, jumpObjects(net, instanceId, sheet), { kind: "net", netId: menu.netId })
	}

	const closeMenu = useCallback(() => setMenu(null), [])
	const part = menu?.kind === "part" ? data?.compiled.components.find(c => c.id === menu.componentId) : undefined
	const hasPcb = project.documents.some(d => d.kind === "pcb" && d.exists)
	const partActions = part
		? [
				...(hasPcb
					? [
							{ label: "Show on PCB", run: () => useAppStore.getState().showOnPcb({ kind: "component", id: part.id }) },
							{ label: "Show in 3D", run: () => useAppStore.getState().showOn3d({ kind: "component", id: part.id }) },
						]
					: []),
				...(data?.bom ? [{ label: "Show in BOM", run: () => useAppStore.getState().setTab("bom") }] : []),
			]
		: []

	const netColorsOn = useAppStore(s => s.netColors.sch)
	return (
		<div className="sch-view" ref={frame} data-status={state.status} data-node={node.id} data-compiled={data ? "true" : "false"}>
			<div className="sch-host" ref={host} data-net-colors={netColorsOn ? "on" : "off"} />
			{state.status === "loading" && <div className="view-message">Loading {node.label}…</div>}
			{state.status === "error" && <div className="view-message error">{state.message}</div>}
			{tip && !menu && (
				<div className="sch-tip" style={{ left: tip.x + 14, top: tip.y + 18 }}>
					On this sheet: {tip.names.join(", ")}
				</div>
			)}
			{menu?.kind === "sheets" && data && (
				<PortMenu key={`${menu.x},${menu.y}`} x={menu.x} y={menu.y} area={menu.area} title={data.compiled.nets[menu.netId]?.physicalName.replaceAll("\\", "")} items={menu.items} onPick={jump} onClose={closeMenu} />
			)}
			{menu?.kind === "part" && part && <PartCard key={`${menu.x},${menu.y}`} x={menu.x} y={menu.y} area={menu.area} component={part} actions={partActions} onClose={closeMenu} />}
		</div>
	)
}
