import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import { StepExportDialog } from "../3d/StepExportDialog"
import { HotkeysButton } from "./Hotkeys"
import { SheetPicker } from "./SheetPicker"
import { flattenHierarchy } from "../model/hierarchy"
import { stripExt } from "../source/paths"
import type { ProjectSummary } from "../model/load-project"
import { Download, Layers, Layers3, Ruler } from "lucide-react"
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
	{ id: "bom", label: "BOM" },
]

// Whether a tab has anything to show: the schematic needs sheets, the board views a board, the BOM
// either.
export function tabEnabled(project: ProjectSummary, tab: ViewTab): boolean {
	const sheets = flattenHierarchy(project.hierarchy).length > 0
	const pcb = project.documents.some(d => d.kind === "pcb" && d.exists)
	return tab === "sch" ? sheets : tab === "bom" ? sheets || pcb : pcb
}

// The tabs in hotkey order: 1 SCH, 2 PCB, 3 3D, 4 BOM.
export const TAB_ORDER: ViewTab[] = ["sch", "pcb", "3d", "bom"]

export function DocBar({ project, tab, activeSheetId, onTab, onSelectSheet, right }: DocBarProps) {
	const sheets = flattenHierarchy(project.hierarchy)
	const hasPcb = project.documents.some(d => d.kind === "pcb" && d.exists)
	const pcbPanelOpen = useAppStore(s => s.pcbPanelOpen)
	const stackupOpen = useAppStore(s => s.pcbStackupOpen)
	const view3dPanelOpen = useAppStore(s => s.view3dPanelOpen)
	const stepExporting = useAppStore(s => s.stepExporting)
	const stepDialogOpen = useAppStore(s => s.stepDialogOpen)
	const measuring = useAppStore(s => s.measuring)
	const enabled = (t: ViewTab) => tabEnabled(project, t)

	return (
		<div className="docbar">
			<div className="docbar-left">
				{tab === "sch" && sheets.length > 0 && <SheetPicker sheets={sheets.map(n => ({ id: n.id, label: `${stripExt(n.fileName)} (${n.displayDesignator})` }))} active={activeSheetId} onPick={onSelectSheet} />}
				{tab === "pcb" && hasPcb && (
					<button className={`docbar-tool${pcbPanelOpen ? " on" : ""}`} onClick={() => useAppStore.getState().setPcbPanelOpen(!pcbPanelOpen)}>
						<Layers size={16} />
						Layers/Objects
					</button>
				)}
				{tab === "pcb" && hasPcb && (
					<button className={`docbar-tool${stackupOpen ? " on" : ""}`} onClick={() => useAppStore.getState().setPcbStackupOpen(!stackupOpen)}>
						<Layers3 size={16} />
						Stackup
					</button>
				)}
				{tab === "3d" && hasPcb && (
					<button className={`docbar-tool${view3dPanelOpen ? " on" : ""}`} onClick={() => useAppStore.getState().setView3dPanelOpen(!view3dPanelOpen)}>
						<Layers size={16} />
						Objects
					</button>
				)}
				{tab === "3d" && hasPcb && (
					<button className="docbar-tool" disabled={stepExporting} onClick={() => useAppStore.getState().setStepDialogOpen(true)}>
						<Download size={16} />
						{stepExporting ? "Exporting…" : "Export STEP"}
					</button>
				)}
			</div>
			<div className="tabs" role="tablist">
				{TABS.map(t => (
					<button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} aria-keyshortcuts={String(TAB_ORDER.indexOf(t.id) + 1)} disabled={!enabled(t.id)} onClick={() => onTab(t.id)}>
						{t.label}
					</button>
				))}
			</div>
			<div className="docbar-right">
				{right}
				{(tab === "pcb" || tab === "3d") && hasPcb && (
					<button className={`docbar-tool${measuring ? " on" : ""}`} aria-label="Ruler" aria-pressed={measuring} aria-keyshortcuts="M" onClick={() => useAppStore.getState().setMeasuring(!measuring)}>
						<Ruler size={16} />
					</button>
				)}
				<HotkeysButton tab={tab} />
			</div>
			{stepDialogOpen &&
				createPortal(
					<StepExportDialog onExport={options => useAppStore.getState().requestStepExport(options)} onClose={() => useAppStore.getState().setStepDialogOpen(false)} />,
					document.body,
				)}
		</div>
	)
}
