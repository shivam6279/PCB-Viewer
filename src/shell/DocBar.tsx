import type { ReactNode } from "react"
import { flattenHierarchy } from "../model/hierarchy"
import { stripExt } from "../source/paths"
import type { ProjectSummary } from "../model/load-project"
import { Layers } from "lucide-react"
import { useAppStore, type ViewTab } from "../app/store"

export interface DocBarProps {
	project: ProjectSummary
	tab: ViewTab
	activeSheetId: string | null
	onTab(tab: ViewTab): void
	onSelectSheet(id: string): void
	right?: ReactNode
}

const TABS: { id: ViewTab; label: string }[] = [
	{ id: "sch", label: "SCH" },
	{ id: "pcb", label: "PCB" },
	{ id: "3d", label: "3D" },
]

export function DocBar({ project, tab, activeSheetId, onTab, onSelectSheet, right }: DocBarProps) {
	const sheets = flattenHierarchy(project.hierarchy)
	const hasPcb = project.documents.some(d => d.kind === "pcb" && d.exists)
	const pcbPanelOpen = useAppStore(s => s.pcbPanelOpen)
	const view3dPanelOpen = useAppStore(s => s.view3dPanelOpen)
	const enabled = (t: ViewTab) => (t === "sch" ? sheets.length > 0 : hasPcb)

	return (
		<div className="docbar">
			<div>
				{tab === "sch" && sheets.length > 0 && (
					<select aria-label="Sheet" value={activeSheetId ?? ""} onChange={e => onSelectSheet(e.target.value)}>
						{sheets.map(n => (
							<option key={n.id} value={n.id}>
								{`${stripExt(n.fileName)} (${n.displayDesignator})`}
							</option>
						))}
					</select>
				)}
				{tab === "pcb" && hasPcb && (
					<button className={`docbar-tool${pcbPanelOpen ? " on" : ""}`} onClick={() => useAppStore.getState().setPcbPanelOpen(!pcbPanelOpen)}>
						<Layers size={16} />
						Layers/Objects
					</button>
				)}
				{tab === "3d" && hasPcb && (
					<button className={`docbar-tool${view3dPanelOpen ? " on" : ""}`} onClick={() => useAppStore.getState().setView3dPanelOpen(!view3dPanelOpen)}>
						<Layers size={16} />
						Objects
					</button>
				)}
			</div>
			<div className="tabs" role="tablist">
				{TABS.map(t => (
					<button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} disabled={!enabled(t.id)} onClick={() => onTab(t.id)}>
						{t.label}
					</button>
				))}
			</div>
			{right ?? <div />}
		</div>
	)
}
