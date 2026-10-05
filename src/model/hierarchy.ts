import type { SheetLink } from "../parse/altium"
import { basename, stripExt } from "../source/paths"

export interface HierarchyNode {
	id: string
	label: string
	docPath: string | null
	fileName: string
	designator: string | null
	// The designator shown: inside a REPEAT channel every sheet below it is numbered too
	// (U_ESC_MCU on channel 2 is "U_ESC_MCU2"); a root shows its file name.
	displayDesignator: string
	channel: number | null
	cyclic: boolean
	children: HierarchyNode[]
}

export interface HierarchyInput {
	sheets: string[]
	linksBySheet: Map<string, SheetLink[]>
	resolve: (fileName: string, fromSheet: string) => string | null
}

export function parseRepeat(designator: string): { name: string; first: number; last: number } | null {
	const m = /^\s*repeat\s*\(\s*([^,()]+?)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*$/i.exec(designator)
	if (!m) return null
	const first = Number(m[2])
	const last = Number(m[3])
	return last < first ? null : { name: m[1]!, first, last }
}

export function buildHierarchy({ sheets, linksBySheet, resolve }: HierarchyInput): HierarchyNode[] {
	const referenced = new Set<string>()
	for (const [from, links] of linksBySheet)
		for (const link of links) {
			const p = resolve(link.fileName, from)
			if (p) referenced.add(p)
		}

	let roots = sheets.filter(s => !referenced.has(s))
	if (roots.length === 0 && sheets.length > 0) roots = [sheets[0]!]

	const usedRootIds = new Set<string>()
	return roots.map(r => makeNode(r, basename(r), null, null, null, uniqueId(basename(r), usedRootIds), []))

	function makeNode(
		docPath: string | null,
		fileName: string,
		designator: string | null,
		channel: number | null,
		inheritedChannel: number | null,
		id: string,
		ancestors: string[],
	): HierarchyNode {
		const displayDesignator =
			designator === null ? stripExt(fileName) : channel === null && inheritedChannel !== null ? `${designator}${inheritedChannel}` : designator
		const label = `${fileName} (${displayDesignator})`
		const node: HierarchyNode = { id, label, docPath, fileName, designator, displayDesignator, channel, cyclic: false, children: [] }
		if (docPath === null) return node
		if (ancestors.includes(docPath)) {
			node.cyclic = true
			return node
		}
		const path = [...ancestors, docPath]
		const usedIds = new Set<string>()
		for (const link of linksBySheet.get(docPath) ?? []) {
			const child = resolve(link.fileName, docPath)
			const file = basename((child ?? link.fileName).replaceAll("\\", "/"))
			const repeat = parseRepeat(link.designator)
			const instances = repeat
				? Array.from({ length: repeat.last - repeat.first + 1 }, (_, k) => ({
						name: `${repeat.name}${repeat.first + k}`,
						channel: repeat.first + k,
					}))
				: [{ name: link.designator, channel: null }]
			for (const inst of instances)
				node.children.push(
					makeNode(child, file, inst.name, inst.channel, inst.channel ?? channel ?? inheritedChannel, uniqueId(`${id}/${inst.name}`, usedIds), path),
				)
		}
		return node
	}
}

function uniqueId(base: string, used: Set<string>): string {
	let id = base
	for (let k = 2; used.has(id); k++) id = `${base}#${k}`
	used.add(id)
	return id
}

export function flattenHierarchy(nodes: HierarchyNode[]): HierarchyNode[] {
	const out: HierarchyNode[] = []
	const visit = (n: HierarchyNode) => {
		out.push(n)
		n.children.forEach(visit)
	}
	nodes.forEach(visit)
	return out
}

export interface Channel {
	index: number
	name: string
}

// The REPEAT channel a sheet instance belongs to: its own, or the nearest one above it.
export function channelOf(nodes: HierarchyNode[], id: string): Channel | null {
	const find = (list: HierarchyNode[], inherited: Channel | null): Channel | null | undefined => {
		for (const n of list) {
			const own = n.channel !== null && n.designator ? { index: n.channel, name: n.designator } : inherited
			if (n.id === id) return own
			const below = find(n.children, own)
			if (below !== undefined) return below
		}
		return undefined
	}
	return find(nodes, null) ?? null
}
