import { useState, type ReactNode } from "react"
import { Check, ChevronDown, ChevronRight, PanelLeftClose, TriangleAlert } from "lucide-react"
import { flattenHierarchy, type HierarchyNode } from "../model/hierarchy"
import type { DocEntry, ProjectSummary } from "../model/load-project"
import type { FileChange } from "../diff/diff"
import { DocIcon, FolderIcon, otherDocKind, type DocKind } from "../app/tree-icons"

// The row that shows the design without any variant's changes.
export const NO_VARIATIONS = "[No Variations]"

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
	// The assembly variant shown (null = "[No Variations]"); the Variants folder lists the project's.
	activeVariant?: string | null
	onSelectVariant?(variant: string | null): void
	// Folds the panel away (its header button); without it there is no button.
	onCollapse?(): void
}

export function ProjectTree({ project, activeSheetId, activePcbPath, onSelectSheet, onSelectPcb, nets, activeNetId, onSelectNet, changes, activeVariant = null, onSelectVariant, onCollapse }: ProjectTreeProps) {
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["nets"]))
	// A sheet placed several times (a multi-channel sheet) is one row whose channels open below it,
	// closed until opened.
	const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
	const flip = (set: Set<string>, id: string) => {
		const next = new Set(set)
		if (next.has(id)) next.delete(id)
		else next.add(id)
		return next
	}
	const isGroup = (id: string) => id.startsWith("channels:")
	const isOpen = (id: string) => (isGroup(id) ? openGroups.has(id) : !collapsed.has(id))
	const toggle = (id: string) => (isGroup(id) ? setOpenGroups(prev => flip(prev, id)) : setCollapsed(prev => flip(prev, id)))
	const docFor = (path: string | null) => (path ? project.documents.find(d => d.path === path) : undefined)

	const row = (key: string, depth: number, label: string, icon: string, opts: {
		hasChildren?: boolean
		active?: boolean
		disabled?: boolean
		problem?: string | null
		onClick?: () => void
		docPath?: string | null
		checked?: boolean
		channels?: number // a multi-channel sheet: how many times it is placed
		channel?: number // one channel of it
		change?: FileChange // its badge, when not its own file's
	}): ReactNode => {
		const change = opts.change ?? (opts.docPath ? changes?.get(opts.docPath) : undefined)
		const open = isOpen(key)
		return (
			<div
				key={key}
				className={`tree-row${opts.active ? " active" : ""}${opts.checked ? " checked" : ""}`}
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
				{icon === "folder" ? (
					<FolderIcon open={open} />
				) : icon === "net" ? (
					<span className="tree-icon net" />
				) : opts.channels !== undefined ? (
					<span className="tree-icon-stack" aria-hidden>
						<DocIcon kind="sch" />
						<DocIcon kind="sch" />
					</span>
				) : opts.channel !== undefined ? (
					<span className="tree-channel">CH {opts.channel}</span>
				) : (
					<DocIcon kind={icon as DocKind} />
				)}
				<span className="tree-label">{label}</span>
				{opts.channels !== undefined && (
					<span className="tree-channels" title={`One sheet placed ${opts.channels} times: ${opts.channels} channels`}>
						×{opts.channels}
					</span>
				)}
				{change && (
					<span className={`tree-change ${change}`} aria-label={CHANGE_WORD[change]}>
						{CHANGE_LETTER[change]}
					</span>
				)}
				{opts.checked && <Check size={13} className="tree-check" aria-label="Shown" />}
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

	const sheetRows = (node: HierarchyNode, depth: number, channel?: number): ReactNode[] => {
		const doc = docFor(node.docPath)
		const out = [
			row(node.id, depth, channel === undefined ? node.label : node.displayDesignator, "sch", {
				hasChildren: node.children.length > 0,
				active: node.id === activeSheetId,
				problem: node.cyclic ? "Sheet hierarchy loops back here" : problemOf(doc, node.docPath),
				onClick: () => onSelectSheet(node.id),
				docPath: node.docPath,
				channel,
			}),
		]
		if (!collapsed.has(node.id)) out.push(...childRows(node, depth + 1))
		return out
	}
	// A node's sub-sheets; one file placed several times under it is one row, its channels below.
	const childRows = (node: HierarchyNode, depth: number): ReactNode[] => {
		const groups = new Map<string, HierarchyNode[]>()
		for (const c of node.children) {
			const k = c.docPath ?? c.fileName
			groups.set(k, [...(groups.get(k) ?? []), c])
		}
		return [...groups.values()].flatMap(list => {
			const first = list[0]!
			if (list.length === 1) return sheetRows(first, depth)
			const key = `channels:${node.id}/${first.docPath ?? first.fileName}`
			const within = list.some(c => activeSheetId === c.id || activeSheetId?.startsWith(`${c.id}/`))
			const out = [
				row(key, depth, first.fileName, "sch", {
					hasChildren: true,
					active: within && !openGroups.has(key),
					problem: problemOf(docFor(first.docPath), first.docPath),
					// Opens its first channel (and lists the channels); once inside, folds and unfolds.
					onClick: () => {
						if (within) return toggle(key)
						onSelectSheet(first.id)
						setOpenGroups(prev => new Set(prev).add(key))
					},
					docPath: first.docPath,
					channels: list.length,
					// Folded, it still says when a sheet in it changed.
					change: flattenHierarchy(list).some(n => n.docPath && changes?.has(n.docPath)) ? (changes?.get(first.docPath ?? "") ?? "modified") : undefined,
				}),
			]
			if (openGroups.has(key)) list.forEach((c, k) => out.push(...sheetRows(c, depth + 1, c.channel ?? k + 1)))
			return out
		})
	}

	const pcbs = project.documents.filter(d => d.kind === "pcb")
	const variants = project.variants ?? []
	const others = project.documents.filter(d => d.kind === "other")

	return (
		<nav className="sidebar" aria-label="Project">
			<div className="sidebar-heading with-action">
				<span>PROJECT</span>
				{onCollapse && (
					<button className="icon-btn" aria-label="Hide project tree" onClick={onCollapse}>
						<PanelLeftClose size={16} />
					</button>
				)}
			</div>
			{row("design", 0, "Design", "folder", { hasChildren: true })}
			{!collapsed.has("design") && variants.length > 0 && row("variants", 1, "Variants", "folder", { hasChildren: true })}
			{!collapsed.has("design") &&
				!collapsed.has("variants") &&
				variants.length > 0 &&
				[null, ...variants.map(v => v.name)].map(name =>
					row(`variant:${name ?? ""}`, 2, name ?? NO_VARIATIONS, "variant", { checked: name === activeVariant, onClick: () => onSelectVariant?.(name) }),
				)}
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
					{others.map(d => row(`other:${d.path}`, 2, d.name, otherDocKind(d.name), { disabled: true }))}
				</>
			)}
			{!collapsed.has("design") && nets && nets.length > 0 && row("nets", 1, "Nets", "folder", { hasChildren: true })}
			{!collapsed.has("design") &&
				!collapsed.has("nets") &&
				nets?.map(n => row(`net:${n.id}`, 2, n.name, "net", { active: n.id === activeNetId, onClick: () => onSelectNet?.(n.id) }))}
		</nav>
	)
}
