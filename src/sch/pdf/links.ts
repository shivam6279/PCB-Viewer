// Where each port, sheet entry and sheet symbol of a sheet instance leads: the other end of its
// connection, for the PDF's links. Pure: the compiled project, the hierarchy and the sheets.
import type { CompiledProject, NetOccurrence } from "../../model/compile"
import { flattenHierarchy, parseRepeat, type HierarchyNode } from "../../model/hierarchy"
import type { SheetData } from "../../model/schematic-data"

// A link from something drawn on a sheet: the record `i` (an entry or port), or every record of a
// sheet symbol (`owner`). The target is objects on another instance, or (no objects) its whole page.
export interface SheetLink {
	from: { i: number } | { owner: number }
	to: { instanceId: string; objects: number[] }
}

export function sheetLinks(hierarchy: HierarchyNode[], compiled: CompiledProject, sheets: Record<string, SheetData>): Map<string, SheetLink[]> {
	const nodes = flattenHierarchy(hierarchy)
	const parentOf = new Map<string, HierarchyNode>()
	for (const n of nodes) for (const c of n.children) parentOf.set(c.id, n)
	const sheetOf = (n: HierarchyNode | undefined) => (n?.docPath ? sheets[n.docPath] : undefined)
	const order = new Map(nodes.map((n, k) => [n.id, k]))

	// The net or bundle an object is part of, with where else it runs.
	const connection = (instanceId: string, i: number): NetOccurrence[] | null => {
		const bundle = compiled.bundleAt[instanceId]?.[i]
		if (bundle !== undefined) return compiled.bundles[bundle]?.occurrences ?? null
		const net = compiled.netAt[instanceId]?.[i]
		return net === undefined ? null : (compiled.nets[net]?.occurrences ?? null)
	}
	const objectsOn = (occurrences: NetOccurrence[], instance: HierarchyNode, keep: (o: SheetData["objects"][number]) => boolean) => {
		const on = new Set(occurrences.find(o => o.instanceId === instance.id)?.objects ?? [])
		return (sheetOf(instance)?.objects ?? []).filter(o => on.has(o.i) && keep(o)).map(o => o.i)
	}
	// The instances a sheet symbol places: one, or every channel of a REPEAT.
	const placedBy = (node: HierarchyNode, sheet: SheetData, symbolI: number): HierarchyNode[] => {
		const symbol = sheet.symbols.find(s => s.i === symbolI)
		if (!symbol) return []
		const repeat = parseRepeat(symbol.designator)
		if (!repeat) return node.children.filter(c => c.designator === symbol.designator)
		const names = new Set(Array.from({ length: repeat.last - repeat.first + 1 }, (_, k) => `${repeat.name}${repeat.first + k}`))
		return node.children.filter(c => c.designator !== null && names.has(c.designator))
	}

	const out = new Map<string, SheetLink[]>()
	for (const node of nodes) {
		const sheet = sheetOf(node)
		if (!sheet) continue
		const links: SheetLink[] = []
		for (const symbol of sheet.symbols) {
			const child = placedBy(node, sheet, symbol.i)[0]
			if (child) links.push({ from: { owner: symbol.i }, to: { instanceId: child.id, objects: [] } })
		}
		for (const o of sheet.objects) {
			if (o.kind !== "entry" && o.kind !== "port") continue
			const occurrences = connection(node.id, o.i)
			const to = (instance: HierarchyNode, objects: number[]) => objects.length > 0 && links.push({ from: { i: o.i }, to: { instanceId: instance.id, objects } })
			if (o.kind === "entry") {
				// Down into the sheet below: its port of this connection, else that sheet.
				const child = placedBy(node, sheet, o.symbol)[0]
				if (!child) continue
				const ports = (sheetOf(child)?.objects ?? []).filter(p => p.kind === "port" && p.name.toUpperCase() === entryName(o.name)).map(p => p.i)
				const fallback = occurrences ? objectsOn(occurrences, child, p => p.kind === "port") : []
				links.push({ from: { i: o.i }, to: { instanceId: child.id, objects: ports.length ? ports : fallback } })
				continue
			}
			// A port goes up to the sheet entry of its name on the symbol placing this sheet (for a REPEAT
			// channel the entry carries the whole bus, not this channel's net)...
			const parent = parentOf.get(node.id)
			const parentSheet = sheetOf(parent)
			if (parent && parentSheet) {
				const symbols = new Set(parentSheet.symbols.filter(s => placedBy(parent, parentSheet, s.i).some(c => c.id === node.id)).map(s => s.i))
				const entries = parentSheet.objects.filter(e => e.kind === "entry" && symbols.has(e.symbol) && entryName(e.name) === o.name.toUpperCase()).map(e => e.i)
				if (to(parent, entries)) continue
				if (occurrences && to(parent, objectsOn(occurrences, parent, e => e.kind === "entry" && symbols.has(e.symbol)))) continue
			}
			// ...else across to the first other sheet beside this one with a port of the name (a flat design)...
			const siblings = parent ? parent.children : hierarchy
			const named = siblings
				.filter(n => n.id !== node.id)
				.map(n => [n, (sheetOf(n)?.objects ?? []).filter(p => p.kind === "port" && p.name.toUpperCase() === o.name.toUpperCase()).map(p => p.i)] as const)
				.find(([, objects]) => objects.length > 0)
			if (named && to(named[0], named[1])) continue
			if (!occurrences) continue
			// ...else to the first other sheet with a port of its net, else any connector.
			const others = occurrences
				.filter(occ => occ.instanceId !== node.id)
				.map(occ => nodes.find(n => n.id === occ.instanceId))
				.filter((n): n is HierarchyNode => n !== undefined)
				.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
			const target =
				others.map(n => [n, objectsOn(occurrences, n, p => p.kind === "port")] as const).find(([, objects]) => objects.length > 0) ??
				others.map(n => [n, objectsOn(occurrences, n, p => p.kind === "entry")] as const).find(([, objects]) => objects.length > 0)
			if (target) to(target[0], target[1])
		}
		out.set(node.id, links)
	}
	return out
}

// The port name a sheet entry pairs with: "REPEAT(IN)" on a REPEAT symbol is the port IN below.
const entryName = (name: string) => (/^repeat\((.*)\)$/i.exec(name.trim())?.[1] ?? name).trim().toUpperCase()
