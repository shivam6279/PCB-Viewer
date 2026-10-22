import { lazy, Suspense, useState, type ReactNode } from "react"
import { PaneContext, type Pane, type PaneMark } from "../app/pane"
import type { ViewTab } from "../app/store"
import type { DeltaSide } from "../app/use-deltas"
import { flattenHierarchy } from "../model/hierarchy"
import { PcbView } from "../pcb/PcbView"
import { boardKey } from "../3d/board-key"
import { SchematicView } from "../sch/SchematicView"
import { loadView3d } from "./ViewArea"
import { BomView } from "../bom/BomView"

const View3d = lazy(loadView3d)

export type DiffSide = DeltaSide

// Two commits side by side, A (primary) left and B (secondary) right, their views kept on the same
// place. The differences (mark) show on A: green what only A has, red what only B has.
// links: the comparison's viewports, the same the single views use (a mode switch keeps the view).
export function DiffArea({ tab, activeSheetId, activePcbPath, a, b, mark, links }: {
	tab: ViewTab
	activeSheetId: string | null
	activePcbPath: string | null
	a: DiffSide
	b: DiffSide
	mark: PaneMark | null
	links: NonNullable<Pane["links"]>
}) {
	const nodeA = activeSheetId ? flattenHierarchy(a.project.hierarchy).find(n => n.id === activeSheetId) ?? null : null
	const nodeB = activeSheetId ? flattenHierarchy(b.project.hierarchy).find(n => n.id === activeSheetId) ?? null : null
	const pcbA = a.project.documents.find(d => d.path === activePcbPath && d.exists) ?? null
	const pcbB = b.project.documents.find(d => d.path === activePcbPath && d.exists) ?? b.project.documents.find(d => d.kind === "pcb" && d.exists) ?? null

	// The board's layers panel sits in a column of its own, left of both boards, covering neither.
	const [panelHost, setPanelHost] = useState<HTMLElement | null>(null)
	const pane = (side: "primary" | "secondary", s: DiffSide, body: ReactNode) => {
		const primary = side === "primary"
		const value: Pane = { side, data: s.data, diff: true, mark: primary ? mark : null, links, panelHost }
		return (
			<div className="diff-pane" aria-label={primary ? "Primary (A)" : "Secondary (B)"}>
				<div className="diff-pane-head">
					<span className={`switch-tag ${side}`}>{primary ? "A" : "B"}</span>
					<code>{s.sha.slice(0, 7)}</code>
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
				{pane("primary", a, nodeA ? <SchematicView key={`a:${nodeA.id}`} source={a.source} project={a.project} node={nodeA} parser={a.parser} /> : missing("Not in this commit"))}
				{pane("secondary", b, nodeB ? <SchematicView key={`b:${nodeB.id}`} source={b.source} project={b.project} node={nodeB} parser={b.parser} /> : missing("Not in this commit"))}
			</section>
		)
	if (tab === "pcb")
		return (
			<section className="diff-area with-panel" aria-label="PCB diff">
				<div className="diff-panel-host" ref={setPanelHost} />
				{pane("primary", a, pcbA ? <PcbView key="a" parser={a.parser} /> : missing("No board in this commit"))}
				{pane("secondary", b, pcbB ? <PcbView key="b" parser={b.parser} /> : missing("No board in this commit"))}
			</section>
		)
	if (tab === "bom")
		return (
			<section className="diff-area" aria-label="BOM diff">
				{pane("primary", a, <BomView projectName={a.project.name} />)}
				{pane("secondary", b, <BomView projectName={b.project.name} />)}
			</section>
		)
	const board = (s: DiffSide, path: string | undefined) =>
		path ? (
			<Suspense fallback={<div className="view-message">Loading board…</div>}>
				<View3d parser={s.parser} active board={boardKey(s.source, path)} readBoard={() => s.source.read(path)} variants={s.project.variants} />
			</Suspense>
		) : (
			missing("No board in this commit")
		)
	return (
		<section className="diff-area" aria-label="3D diff">
			{pane("primary", a, board(a, pcbA?.path))}
			{pane("secondary", b, board(b, pcbB?.path))}
		</section>
	)
}
