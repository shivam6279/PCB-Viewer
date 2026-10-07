import { useEffect, useMemo } from "react"
import { useAppStore } from "./store"
import { TopBar } from "../shell/TopBar"
import { ProjectTree } from "../shell/ProjectTree"
import { DocBar, TAB_ORDER, tabEnabled } from "../shell/DocBar"
import { loadView3d, ViewArea } from "../shell/ViewArea"
import { Inspector } from "../shell/Inspector"
import { workerParser } from "../parse/worker-parser"
import { loadProjectData } from "./load-project-data"
import { GitCommitSource } from "../github/commit-source"
import { CommitSwitcher } from "./CommitSwitcher"
import { navigate } from "./github-open"
import { PaneContext } from "./pane"
import { DiffArea } from "../shell/DiffArea"
import type { CompareMode } from "./store"

export function Viewer() {
	// While parked behind the home screen the viewer keeps rendering its own (hidden) state.
	const screen = useAppStore(s => (s.screen.kind === "viewer" ? s.screen : (s.parked ?? s.screen)))
	const projectData = useAppStore(s => s.projectData)
	const selection = useAppStore(s => s.selection)
	const variant = useAppStore(s => s.variant)
	const { setScreen, setTab, selectSheet, selectPcb } = useAppStore.getState()
	const parser = useMemo(() => workerParser(), [])
	const source = screen.kind === "viewer" ? screen.source : null
	const project = screen.kind === "viewer" ? screen.project : null

	useEffect(() => {
		if (source && project) void loadProjectData(source, project, parser)
	}, [source, project, parser])

	// 1-4: switch to SCH, PCB, 3D, BOM (when that tab has something to show), from anywhere but a text field.
	const viewing = useAppStore(s => s.screen.kind === "viewer") // not parked behind the home screen
	useEffect(() => {
		if (!viewing || !project) return
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return
			if ((e.target as Element | null)?.closest?.("input, textarea, select, [contenteditable]")) return
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
	const onSecondary = mode === "secondary" && secondary !== null
	const data = onSecondary ? (secondary.data.status === "ready" ? secondary.data.data : null) : primaryData

	// The 3D view (code, board geometry, part models) loads in the background once the project is in,
	// so opening the 3D tab later is quick.
	const boardPath = screen.kind === "viewer" ? screen.activePcbPath : null
	useEffect(() => {
		if (!primaryData?.pcb || !source || !boardPath) return
		const timer = setTimeout(() => {
			void loadView3d()
			void import("../3d/prefetch").then(m =>
				m
					.load3d(parser, primaryData, () => source.read(boardPath))
					.done.then(r => r && useAppStore.getState().setView3dPrepared(true))
					.catch(() => {}),
			)
		}, 200)
		return () => clearTimeout(timer)
	}, [primaryData, parser, source, boardPath])

	const nets = useMemo(
		() =>
			data?.compiled.nets
				.map(n => ({ id: n.id, name: n.physicalName }))
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })),
		[data],
	)

	if (screen.kind !== "viewer") return null
	const { tab, activeSheetId, activePcbPath } = screen
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
	const modeBar = compare ? (
		<div className="mode-bar" role="group" aria-label="Compare view">
			{(["primary", "secondary", "diff"] as const).map(m => (
				<button key={m} aria-pressed={mode === m} disabled={!secondary} onClick={() => useAppStore.getState().setCompareMode(m)}>
					{m === "primary" ? "Primary" : m === "secondary" ? "Secondary" : "Diff"}
				</button>
			))}
		</div>
	) : null

	return (
		<div className="viewer">
			{screen.source instanceof GitCommitSource ? (
				<TopBar
					title={screen.project.name}
					subtitle={`${screen.source.ref.owner}/${screen.source.ref.repo}`}
					onBack={() => {
						const git = screen.source as GitCommitSource
						navigate({ kind: "ghProject", owner: git.ref.owner, repo: git.ref.repo, prjPath: screen.project.prjPath ?? "", branch: null })
					}}
				>
					<CommitSwitcher source={screen.source} project={screen.project} />
				</TopBar>
			) : (
				<TopBar title={screen.source.name} subtitle={screen.project.name} onBack={() => setScreen({ kind: "start", error: null })} />
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
			/>
			<main className="main">
				<DocBar project={shown.project} tab={tab} activeSheetId={activeSheetId} onTab={setTab} onSelectSheet={selectSheet} right={modeBar} />
				<div className="main-body">
					{mode === "diff" && secondary && screen.source instanceof GitCommitSource ? (
						<DiffArea
							tab={tab}
							activeSheetId={activeSheetId}
							activePcbPath={activePcbPath}
							a={{ sha: screen.source.sha, source: screen.source, project: screen.project, parser, data: projectData }}
							b={{ sha: secondary.sha, source: secondary.source, project: secondary.project, parser: secondary.parser, data: secondary.data }}
							files={compare?.files ?? null}
						/>
					) : onSecondary ? (
						<PaneContext.Provider value={{ side: "secondary", data: secondary.data, diff: false, mark: null, links: null }}>
							<ViewArea key="secondary" source={shown.source} parser={shown.parser} project={shown.project} tab={tab} activeSheetId={activeSheetId} activePcbPath={activePcbPath} />
						</PaneContext.Provider>
					) : (
						<ViewArea key="primary" source={screen.source} parser={parser} project={screen.project} tab={tab} activeSheetId={activeSheetId} activePcbPath={activePcbPath} />
					)}
					{data && selection && mode !== "diff" && <Inspector parser={shown.parser} tab={tab} project={shown.project} data={data} selection={selection} activeSheetId={activeSheetId} />}
				</div>
			</main>
		</div>
	)
}
