// What a click on a schematic object means, and the menu of sheet instances a port's net
// reaches. Pure: works on the compiled project and the hierarchy, no DOM.
import type { CompiledNet, CompiledProject } from "../model/compile"
import { parseRepeat, type HierarchyNode } from "../model/hierarchy"
import type { SheetData } from "../model/schematic-data"
import { basename, stripExt } from "../source/paths"

// The identity the renderer writes on each drawn record: data-i, data-k, data-o.
export interface Hit {
	i: number
	k: string
	o: number | null
}

export type ClickAction =
	| { kind: "net"; netId: number }
	| { kind: "component"; id: string }
	| { kind: "port"; netId: number; i: number } // port or sheet entry: the instance menu
	| { kind: "symbol"; childId: string; symbolI: number }

const NET_KINDS = new Set(["27", "25", "17", "2", "29"]) // wire, net label, power port, pin, junction
const PORT_KINDS = new Set(["18", "16"]) // port, sheet entry

export function classifyClick(hit: Hit, node: HierarchyNode, sheet: SheetData | undefined, compiled: CompiledProject): ClickAction | null {
	const netAt = compiled.netAt[node.id] ?? {}
	if (PORT_KINDS.has(hit.k)) {
		const netId = netAt[hit.i]
		return netId === undefined ? null : { kind: "port", netId, i: hit.i }
	}
	if (NET_KINDS.has(hit.k)) {
		const netId = netAt[hit.i]
		if (netId !== undefined) return { kind: "net", netId }
	}
	// The owning component / sheet symbol; a hit on the symbol's own rectangle is the owner itself.
	const owner = hit.o ?? (hit.k === "15" || hit.k === "1" ? hit.i : null)
	if (owner !== null) {
		if (sheet?.symbols.some(s => s.i === owner)) {
			const child = symbolChild(node, sheet, owner)
			return child ? { kind: "symbol", childId: child.id, symbolI: owner } : null
		}
		if (sheet?.components.some(c => c.i === owner)) return { kind: "component", id: `${node.id}#${owner}` }
	}
	return null
}

// The child instance a sheet symbol places; for a REPEAT symbol, its first channel.
export function symbolChild(node: HierarchyNode, sheet: SheetData, symbolI: number): HierarchyNode | null {
	const symbol = sheet.symbols.find(s => s.i === symbolI)
	if (!symbol) return null
	const repeat = parseRepeat(symbol.designator)
	const name = repeat ? `${repeat.name}${repeat.first}` : symbol.designator
	return node.children.find(c => c.designator === name) ?? null
}

// "ESC_MCU(U_ESC_MCU1)": a sheet instance as named in the Connectivity list.
export function instanceLabel(node: HierarchyNode): string {
	return `${stripExt(basename(node.fileName))}(${node.displayDesignator})`
}

// "ESC.SchDoc(U_ESC1)": as named in the port menu and the tree.
export function instanceMenuLabel(node: HierarchyNode): string {
	return `${node.fileName}(${node.displayDesignator})`
}

export interface MenuNode {
	key: string
	label: string
	instanceId: string | null // null for a group of REPEAT channels
	reached: boolean // the net has objects on this instance
	current: boolean
	expanded: boolean // groups and branches holding the current instance start open
	children: MenuNode[]
}

// The hierarchy pruned to the instances a net reaches (and their ancestors), with sibling channels of
// one REPEAT grouped as "ESC.SchDoc(U_ESC1, U_ESC2, U_ESC3)".
export function buildPortMenu(hierarchy: HierarchyNode[], net: CompiledNet, currentId: string): MenuNode[] {
	const reached = new Set(net.occurrences.map(o => o.instanceId))
	const build = (node: HierarchyNode): MenuNode | null => {
		const children = groupChannels(node.children.map(build).filter((c): c is MenuNode => c !== null), node.children)
		if (!reached.has(node.id) && children.length === 0) return null
		const current = node.id === currentId
		return {
			key: node.id,
			label: instanceMenuLabel(node),
			instanceId: node.id,
			reached: reached.has(node.id),
			current,
			expanded: current || children.some(c => c.expanded || c.current),
			children,
		}
	}
	return hierarchy.map(build).filter((n): n is MenuNode => n !== null)
}

function groupChannels(items: MenuNode[], nodes: HierarchyNode[]): MenuNode[] {
	const nodeOf = new Map(nodes.map(n => [n.id, n]))
	const slots: (MenuNode | MenuNode[])[] = []
	const groups = new Map<string, MenuNode[]>()
	for (const item of items) {
		const n = nodeOf.get(item.key)
		if (!n || n.channel === null) {
			slots.push(item)
			continue
		}
		const k = n.fileName.toLowerCase()
		let group = groups.get(k)
		if (!group) {
			groups.set(k, (group = []))
			slots.push(group)
		}
		group.push(item)
	}
	return slots.map(slot => {
		if (!Array.isArray(slot)) return slot
		if (slot.length === 1) return slot[0]!
		const first = nodeOf.get(slot[0]!.key)!
		return {
			key: `group:${first.id}`,
			label: `${first.fileName}(${slot.map(m => nodeOf.get(m.key)!.displayDesignator).join(", ")})`,
			instanceId: null,
			reached: false,
			current: false,
			expanded: slot.some(m => m.current || m.expanded),
			children: slot,
		}
	})
}

// The objects to frame when jumping to a net on an instance: its ports and sheet entries there if any
// (the far end of the connection), else every net object on that sheet.
export function jumpObjects(net: CompiledNet, instanceId: string, sheet: SheetData | undefined): number[] {
	const objects = net.occurrences.find(o => o.instanceId === instanceId)?.objects ?? []
	const ports = new Set((sheet?.objects ?? []).filter(o => o.kind === "port" || o.kind === "entry").map(o => o.i))
	const connectors = objects.filter(i => ports.has(i))
	return connectors.length > 0 ? connectors : objects
}
