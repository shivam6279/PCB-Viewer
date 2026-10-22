import { useEffect, useMemo, useState } from "react"
import { useAppStore } from "./store"
import { TopBar } from "../shell/TopBar"
import { ProjectTree } from "../shell/ProjectTree"
import { DocBar, TAB_ORDER, tabEnabled } from "../shell/DocBar"
import { loadView3d, ViewArea } from "../shell/ViewArea"
import { boardKey } from "../3d/board-key"
import { Inspector } from "../shell/Inspector"
import { workerParser } from "../parse/worker-parser"
import { loadProjectData } from "./load-project-data"
import { GitCommitSource } from "../github/commit-source"
import { CommitSwitcher } from "./CommitSwitcher"
import { navigate } from "./github-open"
import { PaneContext, ViewLink } from "./pane"
import { DiffArea } from "../shell/DiffArea"
import { DeltaBar } from "../shell/DeltaBar"
import { useDeltas } from "./use-deltas"
import type { CompareMode, Selection } from "./store"
import { SearchPalette } from "../shell/SearchPalette"
import { buildSearchIndex, type SearchItem } from "../shell/search"
import { useSidebarCollapsed } from "./sidebar-collapsed"
import { PanelLeftOpen } from "lucide-react"
import { queryLocalFonts } from "../sch/pdf/local-fonts"
import { SchPdfDialog } from "../sch/pdf/SchPdfDialog"
import type { SchPdfOptions } from "../sch/pdf/options"
import { flattenHierarchy } from "../model/hierarchy"
import { createPortal } from "react-dom"

export function Viewer() {
	// While parked behind the home screen the viewer keeps rendering its own (hidden) state.
	const screen = useAppStore(s => (s.screen.kind === "viewer" ? s.screen : (s.parked ?? s.screen)))
	const projectData = useAppStore(s => s.projectData)
	const selection = useAppStore(s => s.selection)
	const variant = useAppStore(s => s.variant)
	const { setScreen, setTab, selectSheet, selectPcb } = useAppStore.getState()
	const parser = useMemo(() => workerParser(), [])
	const [pdfBusy, setPdfBusy] = useState<string | null>(null)
	const [pdfDialog, setPdfDialog] = useState(false)
	const source = screen.kind === "viewer" ? screen.source : null
	const project = screen.kind === "viewer" ? screen.project : null

	useEffect(() => {
		if (source && project) void loadProjectData(source, project, parser)
	}, [source, project, parser])

	// 1-4: switch to SCH, PCB, 3D, BOM (when that tab has something to show), from anywhere but a text field.
	// N: net colours on or off in the schematic or on the board, whichever is shown.
	const viewing = useAppStore(s => s.screen.kind === "viewer") // not parked behind the home screen
	useEffect(() => {
		if (!viewing || !project) return
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return
			if ((e.target as Element | null)?.closest?.("input, textarea, select, [contenteditable]")) return
			const { screen: shown, toggleNetColors } = useAppStore.getState()
			if (e.code === "KeyN" && shown.kind === "viewer" && (shown.tab === "sch" || shown.tab === "pcb")) {
				e.preventDefault()
				return toggleNetColors(shown.tab)
			}
			const tab = TAB_ORDER[Number(e.key) - 1]
			if (!tab || !/^[1-4]$/.test(e.key) || !tabEnabled(project, tab)) return
			e.preventDefault()
			useAppStore.getState().setTab(tab)
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [viewing, project])

	const primaryData = projectData.status === "ready" ? projectData.data : null
	// Comparing: the mode bar shows the primary, the compared commit (secondary) or both (diff).
	const compare = useAppStore(s => s.compare)
	const secondary = compare?.source && compare.project ? { ...compare, source: compare.source, project: compare.project } : null
	const mode: CompareMode = secondary ? compare!.mode : "primary"
	const deltas = useAppStore(s => s.deltas)
	const onSecondary = mode === "secondary" && secondary !== null
	const data = onSecondary ? (secondary.data.status === "ready" ? secondary.data.data : null) : primaryData

	// Comparing: the differences of the commit shown against the other one (side by side: the primary's).
	const viewerScreen = screen.kind === "viewer" ? screen : null
	const gitSource = viewerScreen?.source instanceof GitCommitSource ? viewerScreen.source : null
	const sideA = useMemo(
		() => (gitSource && viewerScreen && secondary ? { sha: gitSource.sha, source: gitSource, project: viewerScreen.project, parser, data: projectData } : null),
		[gitSource, viewerScreen?.project, parser, projectData, secondary !== null],
	)
	const sideB = useMemo(
		() => (secondary ? { sha: secondary.sha, source: secondary.source, project: secondary.project, parser: secondary.parser, data: secondary.data } : null),
		[secondary?.sha, secondary?.source, secondary?.project, secondary?.parser, secondary?.data],
	)
	const flip = mode === "secondary"
	const found = useDeltas(viewerScreen?.tab ?? "sch", viewerScreen?.activeSheetId ?? null, viewerScreen?.activePcbPath ?? null, flip ? sideB : sideA, flip ? sideA : sideB, compare?.files ?? null, flip)
	// One viewport per document for the whole comparison, shared by Primary, Secondary and Both: switching
	// modes (or coming back to a sheet) keeps the view where it was.
	const session = compare ? `${gitSource?.sha ?? ""}:${compare.sha}` : null
	const linkMap = useMemo(() => new Map<string, ViewLink<unknown>>(), [session])
	const linkOf = (key: string) => {
		let l = linkMap.get(key)
		if (!l) linkMap.set(key, (l = new ViewLink<unknown>()))
		return l
	}
	const pcbKey = viewerScreen?.activePcbPath ?? ""
	const links = session ? { sch: linkOf(`sch:${viewerScreen?.activeSheetId ?? ""}`), pcb: linkOf(`pcb:${pcbKey}`), view3d: linkOf(`3d:${pcbKey}`), layers: linkOf(`layers:${pcbKey}`) } : null
	// The change picked from the list: the boards go there.
	const [focus, setFocus] = useState<{ area: number; seq: number } | null>(null)
	useEffect(() => setFocus(null), [found])
	// No deltas: nothing marked; deltas: marked over the view; deltas only: over it greyed.
	const deltaMark = useMemo(() => {
		const m = found?.mark
		if (!m || deltas === "none") return null
		return { ...m, dim: deltas === "only", artwork: m.artwork && { ...m.artwork, focus } }
	}, [found, deltas, focus])

	// The 3D view loads in the background, so opening the 3D tab is quick: what needs only the board
	// file (its geometry, its part models) from the moment the project opens, alongside the schematic;
	// the rest once the project's data is in. Then the view is built, hidden (view3dPrepared).
	const boardPath = screen.kind === "viewer" ? screen.activePcbPath : null
	useEffect(() => {
		if (!source || !boardPath || !project?.documents.some(d => d.path === boardPath && d.exists)) return
		void loadView3d()
		void import("../3d/prefetch").then(m => m.startBoard3d(boardKey(source, boardPath), () => source.read(boardPath)))
	}, [source, boardPath, project])
	useEffect(() => {
		if (!primaryData?.pcb || !source || !boardPath) return
		void import("../3d/prefetch").then(m =>
			m
				.load3d(parser, primaryData, boardKey(source, boardPath), () => source.read(boardPath))
				.done.then(r => r && useAppStore.getState().setView3dPrepared(true))
				.catch(() => {}),
		)
	}, [primaryData, parser, source, boardPath])

	const nets = useMemo(
		() =>
			data?.compiled.nets
				.map(n => ({ id: n.id, name: n.physicalName }))
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })),
		[data],
	)

	// The project tree folded away: its own header button (the strip left in its place opens it again),
	// or Ctrl+B / Cmd+B.
	const [sidebarCollapsed, toggleSidebar] = useSidebarCollapsed()
	useEffect(() => {
		if (!viewing) return
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "b") return
			e.preventDefault()
			toggleSidebar()
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [viewing])

	// Project search: the top-bar icon, or Ctrl+F / Cmd+F instead of the browser's find.
	const [searching, setSearching] = useState(false)
	const searchProject = onSecondary ? secondary.project : project
	const searchIndex = useMemo(() => (data && searchProject ? buildSearchIndex(data.compiled, searchProject.hierarchy) : null), [data, searchProject])
	const canSearch = viewing && searchIndex !== null && mode !== "diff"
	useEffect(() => {
		if (!canSearch) return
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return
			e.preventDefault()
			setSearching(true)
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [canSearch])

	if (screen.kind !== "viewer") return null
	const { tab, activeSheetId, activePcbPath } = screen

	// A search hit, shown in the view on screen: framed on the sheet / board / 3D, marked in the BOM.
	const showHit = (item: SearchItem) => {
		const store = useAppStore.getState()
		if (item.kind === "sheet") return store.selectSheet(item.id)
		const selection: Selection = item.kind === "net" ? { kind: "net", netId: item.id } : { kind: "component", id: item.id }
		if (tab === "pcb") return store.showOnPcb(selection)
		if (tab === "3d") return store.showOn3d(selection)
		if (tab === "bom" && item.kind === "component") return store.select(selection)
		const compiled = data!.compiled
		if (item.kind === "component") {
			const c = compiled.components.find(c => c.id === item.id)
			return c ? store.jumpTo(c.instanceId, [c.i], selection) : store.select(selection)
		}
		const net = compiled.nets[item.id]
		const here = net?.occurrences.find(o => o.instanceId === activeSheetId) ?? net?.occurrences[0]
		return here ? store.jumpTo(here.instanceId, here.objects, selection) : store.select(selection)
	}
	// A net picked in the tree: shown on the current sheet if it is there, else where it first appears.
	// On the 3D tab it stays in 3D, framed from the top.
	const selectNet = (id: number) => {
		const net = data?.compiled.nets[id]
		if (!net) return
		if (tab === "3d") return useAppStore.getState().showOn3d({ kind: "net", netId: id })
		const here = net.occurrences.find(o => o.instanceId === activeSheetId) ?? net.occurrences[0]
		if (here) useAppStore.getState().jumpTo(here.instanceId, here.objects, { kind: "net", netId: id })
		else useAppStore.getState().select({ kind: "net", netId: id })
	}

	// What the tree, the views and the inspector show: the primary, or (Secondary) the compared commit.
	const shown = onSecondary ? { source: secondary.source, project: secondary.project, parser: secondary.parser } : { source: screen.source, project: screen.project, parser }
	// Export PDF: its settings first, then every sheet of what is shown, downloaded as <project>[-<commit>].pdf.
	const exportPdf =
		data && mode !== "diff" && !pdfBusy
			? async (options: SchPdfOptions) => {
					const { source: src, project: prj, parser: p } = shown
					setPdfDialog(false)
					// Asked first, while the click still counts as the user's: the sheets' fonts to embed.
					const fonts = queryLocalFonts()
					setPdfBusy("Exporting…")
					try {
						const { exportSchematicPdf } = await import("../sch/pdf/export-pdf")
						const blob = await exportSchematicPdf(src, prj, p, data, options, await fonts, (done, total) => setPdfBusy(`Exporting ${done}/${total}…`))
						const sha = src instanceof GitCommitSource ? `-${src.sha.slice(0, 7)}` : ""
						const a = document.createElement("a")
						a.href = URL.createObjectURL(blob)
						a.download = `${prj.name}${sha}.pdf`
						a.click()
						setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
						setPdfBusy(null)
					} catch (e) {
						console.error(e)
						setPdfBusy("PDF export failed")
						setTimeout(() => setPdfBusy(null), 4000)
					}
				}
			: undefined
	const modeBar = compare ? (
		<>
			{secondary && <DeltaBar deltas={found} here={flip ? "B" : "A"} there={flip ? "A" : "B"} focus={focus?.area ?? null} onFocus={area => setFocus(f => ({ area, seq: (f?.seq ?? 0) + 1 }))} />}
			<div className="mode-bar" role="group" aria-label="Compare view">
				{(["primary", "secondary", "diff"] as const).map(m => (
					<button key={m} aria-pressed={mode === m} disabled={!secondary} onClick={() => useAppStore.getState().setCompareMode(m)}>
						{m === "primary" ? "Primary" : m === "secondary" ? "Secondary" : "Both"}
					</button>
				))}
			</div>
		</>
	) : null

	return (
		<div className={`viewer${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
			{screen.source instanceof GitCommitSource ? (
				<TopBar
					title={screen.project.name}
					subtitle={`${screen.source.ref.owner}/${screen.source.ref.repo}`}
					onSearch={canSearch ? () => setSearching(true) : undefined}
					onBack={() => {
						const git = screen.source as GitCommitSource
						navigate({ kind: "ghProject", owner: git.ref.owner, repo: git.ref.repo, prjPath: screen.project.prjPath ?? "", branch: null })
					}}
				>
					<CommitSwitcher source={screen.source} project={screen.project} />
				</TopBar>
			) : (
				<TopBar title={screen.source.name} subtitle={screen.project.name} onBack={() => setScreen({ kind: "start", error: null })} onSearch={canSearch ? () => setSearching(true) : undefined} />
			)}
			<ProjectTree
				project={shown.project}
				activeSheetId={activeSheetId}
				activePcbPath={activePcbPath}
				onSelectSheet={selectSheet}
				onSelectPcb={selectPcb}
				nets={mode === "diff" ? undefined : nets}
				activeNetId={selection?.kind === "net" ? selection.netId : null}
				onSelectNet={selectNet}
				changes={compare?.files ?? null}
				activeVariant={variant}
				onSelectVariant={useAppStore.getState().setVariant}
				onCollapse={toggleSidebar}
			/>
			{sidebarCollapsed && (
				<div className="sidebar-rail">
					<button className="icon-btn" aria-label="Show project tree" onClick={toggleSidebar}>
						<PanelLeftOpen size={16} />
					</button>
				</div>
			)}
			<main className="main">
				<DocBar project={shown.project} tab={tab} activeSheetId={activeSheetId} onTab={setTab} onSelectSheet={selectSheet} right={modeBar} pdf={{ busy: pdfBusy, onExport: exportPdf && (() => setPdfDialog(true)) }} />
				<div className="main-body">
					{mode === "diff" && sideA && sideB ? (
						<DiffArea tab={tab} activeSheetId={activeSheetId} activePcbPath={activePcbPath} a={sideA} b={sideB} mark={deltaMark} links={links!} />
					) : onSecondary ? (
						<PaneContext.Provider value={{ side: "secondary", data: secondary.data, diff: false, mark: deltaMark, links }}>
							<ViewArea key="secondary" source={shown.source} parser={shown.parser} project={shown.project} tab={tab} activeSheetId={activeSheetId} activePcbPath={activePcbPath} />
						</PaneContext.Provider>
					) : (
						<PaneContext.Provider value={{ side: "primary", data: null, diff: false, mark: secondary ? deltaMark : null, links }}>
							<ViewArea key="primary" source={screen.source} parser={parser} project={screen.project} tab={tab} activeSheetId={activeSheetId} activePcbPath={activePcbPath} />
						</PaneContext.Provider>
					)}
					{data && selection && mode !== "diff" && <Inspector parser={shown.parser} tab={tab} project={shown.project} data={data} selection={selection} activeSheetId={activeSheetId} />}
				</div>
			</main>
			{pdfDialog &&
				exportPdf &&
				createPortal(<SchPdfDialog hasChannels={new Set(flattenHierarchy(shown.project.hierarchy).map(n => n.docPath?.toLowerCase())).size < flattenHierarchy(shown.project.hierarchy).length} onExport={exportPdf} onClose={() => setPdfDialog(false)} />, document.body)}
			{searching && searchIndex && <SearchPalette items={searchIndex} onPick={showHit} onClose={() => setSearching(false)} />}
		</div>
	)
}
