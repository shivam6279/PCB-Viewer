import { lazy, Suspense, useEffect, useState } from "react"
import { flattenHierarchy } from "../model/hierarchy"
import type { ProjectSummary } from "../model/load-project"
import type { Parser } from "../parse/parser"
import { SchematicView } from "../sch/SchematicView"
import { PcbView } from "../pcb/PcbView"
import { BomView } from "../bom/BomView"
import type { ProjectSource } from "../source/types"
import { useAppStore, type ViewTab } from "../app/store"
import { whenIdle } from "../app/idle"
import { usePane, usePaneData } from "../app/pane"

// three.js and the STEP importer load in their own chunk (fetched in the background, see Viewer).
export const loadView3d = () => import("../3d/View3d").then(m => ({ default: m.View3d }))
const View3d = lazy(loadView3d)

// The SCH, PCB and 3D views. Each stays mounted once opened and is only hidden when another tab is
// shown, so switching tabs is instant: nothing is rebuilt or reloaded.
export function ViewArea({ source, parser, project, tab, activeSheetId, activePcbPath }: {
	source: ProjectSource
	parser: Parser
	project: ProjectSummary
	tab: ViewTab
	activeSheetId: string | null
	activePcbPath: string | null
}) {
	const view = tab === "sch" ? "Schematic" : tab === "pcb" ? "PCB" : tab === "bom" ? "BOM" : "3D"
	const sheet = flattenHierarchy(project.hierarchy).find(n => n.id === activeSheetId)
	const pcb = project.documents.find(d => d.path === activePcbPath)
	const [opened, setOpened] = useState<Set<ViewTab>>(() => new Set([tab]))
	useEffect(() => setOpened(prev => (prev.has(tab) ? prev : new Set([...prev, tab]))), [tab])
	// Once its data is in, the 3D view is built ahead (hidden), so even its first showing is instant;
	// the PCB view likewise, in idle time once the project is compiled.
	const paneSide = usePane().side
	const prepared = useAppStore(s => s.view3dPrepared) && paneSide === "primary"
	const dataReady = usePaneData().status === "ready"
	useEffect(() => {
		if (!dataReady || !pcb) return
		return whenIdle(() => setOpened(prev => (prev.has("pcb") ? prev : new Set([...prev, "pcb"]))))
	}, [dataReady, pcb])
	const pane = (id: ViewTab) => `view-pane${tab === id ? "" : " hidden"}`

	return (
		<section className="view-area" aria-label={`${view} view`}>
			{opened.has("sch") && (
				<div className={pane("sch")}>
					{sheet ? <SchematicView key={sheet.id} source={source} project={project} node={sheet} parser={parser} /> : <div className="view-message">No sheet selected</div>}
				</div>
			)}
			{opened.has("pcb") && (
				<div className={pane("pcb")}>
					<PcbView parser={parser} active={tab === "pcb"} />
				</div>
			)}
			{(opened.has("3d") || prepared) && (
				<div className={pane("3d")}>
					{pcb ? (
						<Suspense fallback={<div className="view-message">Loading board…</div>}>
							<View3d parser={parser} active={tab === "3d"} readBoard={() => source.read(pcb.path)} />
						</Suspense>
					) : (
						<div className="view-message">No board</div>
					)}
				</div>
			)}
			{opened.has("bom") && (
				<div className={pane("bom")}>
					<BomView projectName={project.name} />
				</div>
			)}
		</section>
	)
}
