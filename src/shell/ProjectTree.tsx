import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react"
import type { HierarchyNode } from "../model/hierarchy"
import type { DocEntry, ProjectSummary } from "../model/load-project"
import type { FileChange } from "../diff/diff"

const CHANGE_LETTER: Record<FileChange, string> = { modified: "M", added: "A", removed: "D" }
const CHANGE_WORD: Record<FileChange, string> = { modified: "Changed", added: "Added", removed: "Deleted" }

export interface ProjectTreeProps {
	project: ProjectSummary
	activeSheetId: string | null
	activePcbPath: string | null
	onSelectSheet(id: string): void
	onSelectPcb(path: string): void
	// Compiled nets by physical name, once the project has compiled.
	nets?: { id: number; name: string }[]
	activeNetId?: number | null
	onSelectNet?(id: number): void
	// Comparing commits: how each document differs (badge M / A / D on its row).
	changes?: Map<string, FileChange> | null
}

export function ProjectTree({ project, activeSheetId, activePcbPath, onSelectSheet, onSelectPcb, nets, activeNetId, onSelectNet, changes }: ProjectTreeProps) {
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["nets"]))
	const toggle = (id: string) =>
		setCollapsed(prev => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	const docFor = (path: string | null) => (path ? project.documents.find(d => d.path === path) : undefined)

	const row = (key: string, depth: number, label: string, icon: string, opts: {
		hasChildren?: boolean
		active?: boolean
		disabled?: boolean
		problem?: string | null
		onClick?: () => void
		docPath?: string | null
	}): ReactNode => {
		const change = opts.docPath ? changes?.get(opts.docPath) : undefined
		const open = !collapsed.has(key)
		return (
			<div
				key={key}
				className={`tree-row${opts.active ? " active" : ""}`}
				style={{ paddingLeft: 8 + depth * 18 }}
				aria-disabled={opts.disabled ? "true" : undefined}
				onClick={opts.disabled ? undefined : opts.onClick}
			>
				{opts.hasChildren ? (
					<button
						className="tree-chevron"
						aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
						onClick={e => {
							e.stopPropagation()
							toggle(key)
						}}
					>
						{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					</button>
				) : (
					<span className="tree-chevron" />
				)}
				<span className={`tree-icon ${icon}`} />
				<span className="tree-label">{label}</span>
				{change && (
					<span className={`tree-change ${change}`} aria-label={CHANGE_WORD[change]}>
						{CHANGE_LETTER[change]}
					</span>
				)}
				{opts.problem && (
					<span className="tree-warn" title={opts.problem}>
						<TriangleAlert size={13} />
					</span>
				)}
			</div>
		)
	}

	const problemOf = (doc: DocEntry | undefined, docPath: string | null) =>
		docPath === null || (doc && !doc.exists) ? "File not found" : (doc?.error ?? null)

	const sheetRows = (node: HierarchyNode, depth: number): ReactNode[] => {
		const doc = docFor(node.docPath)
		const out = [
			row(node.id, depth, node.label, "sch", {
				hasChildren: node.children.length > 0,
				active: node.id === activeSheetId,
				problem: node.cyclic ? "Sheet hierarchy loops back here" : problemOf(doc, node.docPath),
				onClick: () => onSelectSheet(node.id),
				docPath: node.docPath,
			}),
		]
		if (!collapsed.has(node.id)) for (const c of node.children) out.push(...sheetRows(c, depth + 1))
		return out
	}

	const pcbs = project.documents.filter(d => d.kind === "pcb")
	const others = project.documents.filter(d => d.kind === "other")

	return (
		<nav className="sidebar" aria-label="Project">
			<div className="sidebar-heading">PROJECT</div>
			{row("design", 0, "Design", "folder", { hasChildren: true })}
			{!collapsed.has("design") && row("source", 1, "Source Documents", "folder", { hasChildren: true })}
			{!collapsed.has("design") && !collapsed.has("source") && (
				<>
					{project.hierarchy.flatMap(n => sheetRows(n, 2))}
					{pcbs.map(d =>
						row(`pcb:${d.path}`, 2, d.name, "pcb", {
							active: d.path === activePcbPath,
							disabled: !d.exists,
							problem: problemOf(d, d.path),
							onClick: () => onSelectPcb(d.path),
							docPath: d.path,
						}),
					)}
					{others.map(d => row(`other:${d.path}`, 2, d.name, "other", { disabled: true }))}
				</>
			)}
			{!collapsed.has("design") && nets && nets.length > 0 && row("nets", 1, "Nets", "folder", { hasChildren: true })}
			{!collapsed.has("design") &&
				!collapsed.has("nets") &&
				nets?.map(n => row(`net:${n.id}`, 2, n.name, "net", { active: n.id === activeNetId, onClick: () => onSelectNet?.(n.id) }))}
		</nav>
	)
}
