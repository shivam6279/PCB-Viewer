import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react"
import { PaneContext, ViewLink, type Pane, type PaneMark } from "../app/pane"
import type { ProjectDataState, ViewTab } from "../app/store"
import { diffByKey, diffPcb, mostlyChanged, schGroupKey, type FileChange, type ObjectDiff } from "../diff/diff"
import { channelOf, flattenHierarchy, type HierarchyNode } from "../model/hierarchy"
import type { ProjectSummary } from "../model/load-project"
import type { Parser } from "../parse/parser"
import { PcbView } from "../pcb/PcbView"
import { pcbScene } from "../pcb/use-scene"
import { loadSheet, SchematicView } from "../sch/SchematicView"
import type { ProjectSource } from "../source/types"
import { loadView3d } from "./ViewArea"

const View3d = lazy(loadView3d)

export interface DiffSide {
	sha: string
	source: ProjectSource
	project: ProjectSummary
	parser: Parser
	data: ProjectDataState
}

type Marks = { a: PaneMark | null; b: PaneMark | null; note: string | null } | null // null: still working out

// Two commits side by side, A (primary) left and B (secondary) right, their views kept on the same
// place. What only A has is red on A; what only B has is green on B.
export function DiffArea({ tab, activeSheetId, activePcbPath, a, b, files }: {
	tab: ViewTab
	activeSheetId: string | null
	activePcbPath: string | null
	a: DiffSide
	b: DiffSide
	files: Map<string, FileChange> | null
}) {
	const nodeA = activeSheetId ? flattenHierarchy(a.project.hierarchy).find(n => n.id === activeSheetId) ?? null : null
	const nodeB = activeSheetId ? flattenHierarchy(b.project.hierarchy).find(n => n.id === activeSheetId) ?? null : null
	const pcbA = a.project.documents.find(d => d.path === activePcbPath && d.exists) ?? null
	const pcbB = b.project.documents.find(d => d.path === activePcbPath && d.exists) ?? b.project.documents.find(d => d.kind === "pcb" && d.exists) ?? null
	// A fresh link per thing shown: a new sheet starts fitted, not where the last one was.
	const links = useMemo(
		() => ({ sch: new ViewLink<unknown>(), pcb: new ViewLink<unknown>(), view3d: new ViewLink<unknown>(), layers: new ViewLink<unknown>() }),
		[a.source, b.source, activeSheetId, activePcbPath],
	)

	const schChange = nodeA?.docPath ? files?.get(nodeA.docPath) : nodeB?.docPath ? files?.get(nodeB.docPath) : undefined
	const pcbChange = pcbA ? files?.get(pcbA.path) : pcbB ? files?.get(pcbB.path) : undefined
	const schMarks = useSchMarks(tab === "sch" ? a : null, nodeA, b, nodeB, schChange)
	const pcbMarks = usePcbMarks(tab === "pcb" ? a : null, b, pcbChange)
	const marks = tab === "sch" ? schMarks : tab === "pcb" ? pcbMarks : { a: null, b: null, note: "3D: side by side (differences are marked in SCH and PCB)" }

	// The board's layers panel sits in a column of its own, left of both boards, covering neither.
	const [panelHost, setPanelHost] = useState<HTMLElement | null>(null)
	const pane = (side: "primary" | "secondary", s: DiffSide, mark: PaneMark | null, body: ReactNode) => {
		const value: Pane = { side, data: s.data, diff: true, mark, links, panelHost }
		return (
			<div className="diff-pane" aria-label={side === "primary" ? "Primary (A)" : "Secondary (B)"}>
				<div className="diff-pane-head">
					<span className={`switch-tag ${side}`}>{side === "primary" ? "A" : "B"}</span>
					<code>{s.sha.slice(0, 7)}</code>
					<span className={`count ${mark ? mark.tone : ""}`}>{headNote(marks, mark, side)}</span>
				</div>
				<div className="diff-pane-body">
					<PaneContext.Provider value={value}>{body}</PaneContext.Provider>
				</div>
			</div>
		)
	}
	const missing = (what: string) => <div className="view-message">{what}</div>

	if (tab === "sch")
		return (
			<section className="diff-area" aria-label="Schematic diff">
				{pane("primary", a, marks?.a ?? null, nodeA ? <SchematicView key={`a:${nodeA.id}`} source={a.source} project={a.project} node={nodeA} parser={a.parser} /> : missing("Not in this commit"))}
				{pane("secondary", b, marks?.b ?? null, nodeB ? <SchematicView key={`b:${nodeB.id}`} source={b.source} project={b.project} node={nodeB} parser={b.parser} /> : missing("Not in this commit"))}
			</section>
		)
	if (tab === "pcb")
		return (
			<section className="diff-area with-panel" aria-label="PCB diff">
				<div className="diff-panel-host" ref={setPanelHost} />
				{pane("primary", a, marks?.a ?? null, pcbA ? <PcbView key="a" parser={a.parser} /> : missing("No board in this commit"))}
				{pane("secondary", b, marks?.b ?? null, pcbB ? <PcbView key="b" parser={b.parser} /> : missing("No board in this commit"))}
			</section>
		)
	const board = (s: DiffSide, path: string | undefined) =>
		path ? (
			<Suspense fallback={<div className="view-message">Loading board…</div>}>
				<View3d parser={s.parser} active readBoard={() => s.source.read(path)} />
			</Suspense>
		) : (
			missing("No board in this commit")
		)
	return (
		<section className="diff-area" aria-label="3D diff">
			{pane("primary", a, null, board(a, pcbA?.path))}
			{pane("secondary", b, null, board(b, pcbB?.path))}
		</section>
	)
}

function headNote(marks: Marks, mark: PaneMark | null, side: "primary" | "secondary"): string {
	if (marks === null) return "Comparing…"
	if (marks.note) return marks.note
	if (!mark) return ""
	if (mark.mostly) return "Most of it changed"
	const n = mark.ids.size
	const pours = mark.repoured ? ` · ${mark.repoured} re-poured` : ""
	if (n === 0) return (side === "primary" ? "Nothing removed" : "Nothing added") + pours
	return `${n} ${side === "primary" ? "removed / changed" : "added / changed"}${pours}`
}

const toMarks = (d: ObjectDiff, idsA: (i: number) => number, idsB: (i: number) => number): Marks => {
	const mostly = mostlyChanged(d)
	return {
		a: { ids: new Set([...d.onlyA].map(idsA)), tone: "removed", mostly },
		b: { ids: new Set([...d.onlyB].map(idsB)), tone: "added", mostly },
		note: null,
	}
}

const UNCHANGED: Marks = { a: null, b: null, note: "No changes in this file" }

// The sheet's record groups on each side, fingerprinted by how they draw.
function useSchMarks(a: DiffSide | null, nodeA: HierarchyNode | null, b: DiffSide, nodeB: HierarchyNode | null, change: FileChange | undefined): Marks {
	const [marks, setMarks] = useState<Marks>(null)
	useEffect(() => {
		if (!a) return
		if (!nodeA?.docPath || !nodeB?.docPath) return setMarks({ a: null, b: null, note: change === "added" ? "Added in B" : change === "removed" ? "Deleted in B" : null })
		if (!change) return setMarks(UNCHANGED)
		let live = true
		setMarks(null)
		const groups = async (s: DiffSide, n: HierarchyNode) => {
			const sheet = await loadSheet(s.source, s.project, n.docPath!, channelOf(s.project.hierarchy, n.id), s.parser)
			const doc = new DOMParser().parseFromString(sheet.markup, "image/svg+xml")
			return [...doc.querySelectorAll("g[data-i]")].map(g => ({ i: Number(g.getAttribute("data-i")), key: schGroupKey(g.getAttribute("data-k") ?? "", g.outerHTML) }))
		}
		Promise.all([groups(a, nodeA), groups(b, nodeB)]).then(
			([ga, gb]) => live && setMarks(toMarks(diffByKey(ga, gb, g => g.key), i => ga[i]!.i, i => gb[i]!.i)),
			() => live && setMarks({ a: null, b: null, note: "Couldn't compare this sheet" }),
		)
		return () => {
			live = false
		}
	}, [a, b, nodeA, nodeB, change])
	return marks
}

// The boards' objects on each side, fingerprinted by kind, layer, net and shape.
function usePcbMarks(a: DiffSide | null, b: DiffSide, change: FileChange | undefined): Marks {
	const [marks, setMarks] = useState<Marks>(null)
	const dataA = a?.data.status === "ready" ? a.data.data : null
	const dataB = b.data.status === "ready" ? b.data.data : null
	useEffect(() => {
		if (!a) return
		if (!change) return setMarks(UNCHANGED)
		if (!dataA || !dataB) return setMarks(null)
		let live = true
		Promise.all([pcbScene(a.parser, dataA), pcbScene(b.parser, dataB)]).then(
			([sa, sb]) => {
				if (!live) return
				if (!sa || !sb) return setMarks({ a: null, b: null, note: sa ? "No board in B" : "No board in A" })
				const m = toMarks(diffPcb(sa.objects, sb.objects), i => sa.objects[i]!.id, i => sb.objects[i]!.id)
				// Re-poured polygons differ whenever anything near them moved; painted they would cover
				// the board and hide the tracks and pads that changed. They are counted instead.
				const solid = (mark: PaneMark | null, objects: typeof sa.objects) => {
					if (!mark) return mark
					const ids = new Set([...mark.ids].filter(id => !objects[id]?.pour))
					return { ...mark, ids, repoured: mark.ids.size - ids.size }
				}
				setMarks(m && { ...m, a: solid(m.a, sa.objects), b: solid(m.b, sb.objects) })
			},
			() => live && setMarks({ a: null, b: null, note: "Couldn't compare the boards" }),
		)
		return () => {
			live = false
		}
	}, [a, b, dataA, dataB, change])
	return marks
}
