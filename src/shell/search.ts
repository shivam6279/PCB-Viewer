// Project quick search (top-bar icon, Ctrl+F): components, nets and sheet instances of the open
// project, ranked by how well their name matches. Pure: works on the compiled project.
import type { CompiledProject } from "../model/compile"
import { flattenHierarchy, type HierarchyNode } from "../model/hierarchy"
import { instanceLabel } from "../sch/interaction"

export type SearchItem =
	| { kind: "component"; id: string; label: string; detail: string; also: string[] }
	| { kind: "net"; id: number; label: string; detail: string; also: string[] }
	| { kind: "sheet"; id: string; label: string; detail: string; also: string[] }

const KIND_ORDER = { component: 0, net: 1, sheet: 2 }

export function buildSearchIndex(compiled: CompiledProject, hierarchy: HierarchyNode[]): SearchItem[] {
	const items: SearchItem[] = []
	for (const c of compiled.components)
		items.push({ kind: "component", id: c.id, label: c.designator, detail: c.comment, also: [c.logicalDesignator, c.description, c.libReference, c.footprint] })
	for (const n of compiled.nets)
		items.push({ kind: "net", id: n.id, label: n.physicalName, detail: n.netName !== n.physicalName ? n.netName : "", also: n.names })
	for (const node of flattenHierarchy(hierarchy))
		if (node.docPath) items.push({ kind: "sheet", id: node.id, label: instanceLabel(node), detail: node.fileName, also: [] })
	return items
}

// Lower is better: the name exactly, then its start, then a word inside it ("SDA" in I2C_SDA), then
// anywhere in it, then the comment / other names. Null: no match.
function score(item: SearchItem, q: string): number | null {
	const label = item.label.toLowerCase()
	if (label === q) return 0
	if (label.startsWith(q)) return 1
	const at = label.indexOf(q)
	if (at > 0 && /[^a-z0-9]/.test(label[at - 1]!)) return 2
	if (at > 0) return 3
	if (item.detail.toLowerCase().includes(q)) return 4
	if (item.also.some(a => a.toLowerCase().includes(q))) return 5
	return null
}

export function searchItems(items: SearchItem[], query: string, limit = 60): SearchItem[] {
	const q = query.trim().toLowerCase()
	if (!q) return []
	const hits: { item: SearchItem; s: number }[] = []
	for (const item of items) {
		const s = score(item, q)
		if (s !== null) hits.push({ item, s })
	}
	hits.sort(
		(a, b) =>
			a.s - b.s ||
			KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
			a.item.label.localeCompare(b.item.label, undefined, { numeric: true, sensitivity: "base" }),
	)
	return hits.slice(0, limit).map(h => h.item)
}
