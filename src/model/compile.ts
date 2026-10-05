// Project-wide net compilation: joins every sheet instance's local nets into the project's nets,
// the way Altium compiles a hierarchical, multi-channel design.
// - ports join the parent sheet symbol's entry of the same name (hierarchical net scope);
// - power ports (and hidden power pins) join globally by name;
// - signal harness members join across levels by entry name;
// - each REPEAT channel instance gets its own copies of the nets that live inside it.
// Naming follows Altium: power port names first, then the highest-level net label, then the
// highest-level port, then the harness ("<harness>.<member>"), else "Net<designator>_<pin>".
// Nets confined to one channel get "_<channel index>" in their physical name, as on the PCB.
import { sheetConnectivity, type SheetConnectivity } from "./connectivity"
import { parseRepeat, type HierarchyNode } from "./hierarchy"
import type { Parameter, SheetData } from "./schematic-data"

export interface CompileInstance {
	id: string
	docPath: string
	parentId: string | null
	designator: string | null // sheet symbol designator this instance was placed by (channel-expanded)
	channel: { index: number; name: string } | null // own or inherited REPEAT channel
}

export interface NetOccurrence {
	instanceId: string
	objects: number[]
}

export interface CompiledNet {
	id: number
	netName: string
	physicalName: string
	names: string[] // every name the net carries anywhere (labels, ports, power ports)
	occurrences: NetOccurrence[]
	pins: { component: string; pin: string; path: string }[] // physical designator, pin designator, component source path
}

export interface CompiledComponent {
	id: string // `${instanceId}#${i}`
	instanceId: string
	i: number
	designator: string
	logicalDesignator: string
	comment: string
	description: string
	libReference: string
	footprint: string
	uniqueId: string
	uniquePath: string // Altium's source path, e.g. "\1OCQKBGNW\SRADDCIC\BHDUXFNR"; links it to the PCB
	parameters: Parameter[]
}

export interface CompiledProject {
	nets: CompiledNet[]
	components: CompiledComponent[]
	netAt: Record<string, Record<number, number>> // instance id -> object i -> net id
}

export interface CompileInput {
	instances: CompileInstance[]
	sheets: Map<string, SheetData>
	designatorFormat: string
	// Optional PCB truth: "<component source path>|<pad>" -> PCB net name, used for physical names.
	padNets?: Map<string, string>
}

export function formatDesignator(designator: string, channel: { index: number; name: string } | null, format: string): string {
	if (!channel) return designator
	return format
		.replaceAll("$Component", designator)
		.replaceAll("$ChannelIndex", String(channel.index))
		.replaceAll("$ChannelAlpha", String.fromCharCode(64 + channel.index))
		.replaceAll("$RoomName", channel.name)
}

// Every sheet instance of the project hierarchy, with its parent and (inherited) channel.
export function compileInstances(hierarchy: HierarchyNode[]): CompileInstance[] {
	const out: CompileInstance[] = []
	const visit = (node: HierarchyNode, parent: CompileInstance | null) => {
		if (!node.docPath || node.cyclic) return
		const channel = node.channel !== null && node.designator ? { index: node.channel, name: node.designator } : (parent?.channel ?? null)
		const inst: CompileInstance = { id: node.id, docPath: node.docPath, parentId: parent?.id ?? null, designator: node.designator, channel }
		out.push(inst)
		for (const child of node.children) visit(child, inst)
	}
	for (const root of hierarchy) visit(root, null)
	return out
}

class Union {
	private parent = new Map<string, string>()
	find(a: string): string {
		if (!this.parent.has(a)) this.parent.set(a, a)
		let r = a
		while (this.parent.get(r) !== r) r = this.parent.get(r)!
		this.parent.set(a, r)
		return r
	}
	union(a: string, b: string) {
		const ra = this.find(a)
		const rb = this.find(b)
		if (ra !== rb) this.parent.set(rb, ra)
	}
}

export function compileProject({ instances, sheets, designatorFormat, padNets }: CompileInput): CompiledProject {
	const local = new Map<string, SheetConnectivity>()
	const connectivityOf = (docPath: string) => {
		let c = local.get(docPath)
		if (!c) local.set(docPath, (c = sheetConnectivity(sheets.get(docPath) ?? { objects: [], components: [], symbols: [] })))
		return c
	}
	const byId = new Map(instances.map(inst => [inst.id, inst]))
	const depth = (inst: CompileInstance): number => (inst.parentId ? 1 + depth(byId.get(inst.parentId)!) : 0)
	const netKey = (inst: string, id: number) => `${inst}#${id}`
	const nets = new Union()
	const bundles = new Union()

	const powerKeys = new Map<string, string>()
	for (const inst of instances) {
		const c = connectivityOf(inst.docPath)
		for (const net of c.nets) {
			nets.find(netKey(inst.id, net.id))
			for (const power of net.powers) {
				const k = power.toUpperCase()
				const first = powerKeys.get(k)
				if (first) nets.union(first, netKey(inst.id, net.id))
				else powerKeys.set(k, netKey(inst.id, net.id))
			}
		}
	}

	// Vertical connections: child ports <-> the parent's sheet entries on the symbol that placed it.
	// Also builds each instance's unique path (symbol ids, a REPEAT symbol's prefixed by the channel).
	const pathOf = new Map<string, string>()
	for (const inst of instances) if (!inst.parentId) pathOf.set(inst.id, "")
	for (const child of instances) {
		if (!child.parentId || !child.designator) continue
		const parent = byId.get(child.parentId)!
		const parentSheet = sheets.get(parent.docPath)
		const symbol = parentSheet?.symbols.find(s => {
			if (s.designator === child.designator) return true
			const r = parseRepeat(s.designator)
			return r !== null && Array.from({ length: r.last - r.first + 1 }, (_, k) => `${r.name}${r.first + k}`).includes(child.designator!)
		})
		if (!symbol) continue
		const channelPrefix = parseRepeat(symbol.designator) && child.channel?.name === child.designator ? String(child.channel.index) : ""
		pathOf.set(child.id, `${pathOf.get(parent.id) ?? ""}\\${channelPrefix}${symbol.uniqueId}`)
		const pc = connectivityOf(parent.docPath)
		const cc = connectivityOf(child.docPath)
		for (const cnet of cc.nets)
			for (const port of cnet.ports)
				for (const pnet of pc.nets)
					if (pnet.entries.some(e => e.symbol === symbol.i && e.name.toUpperCase() === port.toUpperCase()))
						nets.union(netKey(child.id, cnet.id), netKey(parent.id, pnet.id))
		for (const ch of cc.harnesses)
			for (const port of ch.ports)
				for (const ph of pc.harnesses)
					if (ph.entries.some(e => e.symbol === symbol.i && e.name.toUpperCase() === port.toUpperCase()))
						bundles.union(netKey(child.id, ch.id), netKey(parent.id, ph.id))
	}

	// Harness members: within each unified bundle, entries with the same name are one net.
	const bundleMembers = new Map<string, Map<string, string>>() // bundle root -> member -> first net key
	const bundleName = new Map<string, { name: string; depth: number; rank: number }>()
	const memberOf = new Map<string, { bundle: string; member: string }>() // net key -> harness member
	const joinMember = (root: string, member: string, k: string) => {
		let members = bundleMembers.get(root)
		if (!members) bundleMembers.set(root, (members = new Map()))
		memberOf.set(k, { bundle: root, member })
		const first = members.get(member.toUpperCase())
		if (first) nets.union(first, k)
		else members.set(member.toUpperCase(), k)
	}
	for (const inst of instances) {
		const c = connectivityOf(inst.docPath)
		for (const h of c.harnesses) {
			const root = bundles.find(netKey(inst.id, h.id))
			const d = depth(inst)
			// A label on the harness wire names it; otherwise its ports/entries do. Highest level wins.
			const candidates = [...h.labels.map(name => ({ name, rank: 0 })), ...[...h.ports, ...h.entries.map(e => e.name)].map(name => ({ name, rank: 1 }))]
			for (const { name, rank } of candidates) {
				const best = bundleName.get(root)
				if (!best || d < best.depth || (d === best.depth && rank < best.rank)) bundleName.set(root, { name, depth: d, rank })
			}
			for (const [member, netId] of h.members) joinMember(root, member, netKey(inst.id, netId))
		}
	}
	// "BUNDLE.MEMBER" net labels join that member of the harness named BUNDLE on the same sheet.
	for (const inst of instances) {
		const c = connectivityOf(inst.docPath)
		for (const net of c.nets)
			for (const label of net.labels) {
				const dot = label.lastIndexOf(".")
				if (dot <= 0) continue
				const bundle = label.slice(0, dot).toUpperCase()
				const h = c.harnesses.find(h => [...h.labels, ...h.ports, ...h.entries.map(e => e.name)].some(n => n.toUpperCase() === bundle))
				if (h) joinMember(bundles.find(netKey(inst.id, h.id)), label.slice(dot + 1), netKey(inst.id, net.id))
			}
	}

	// Components with channel designators.
	const components: CompiledComponent[] = []
	const designatorOf = new Map<string, string>() // `${inst}#${componentIndex}` -> physical designator
	const pathOfComponent = new Map<string, string>() // `${inst}#${componentIndex}` -> source path
	for (const inst of instances)
		for (const c of sheets.get(inst.docPath)?.components ?? []) {
			const uniquePath = `${pathOf.get(inst.id) ?? ""}\\${c.uniqueId}`
			const designator = formatDesignator(c.designator, inst.channel, designatorFormat)
			designatorOf.set(`${inst.id}#${c.i}`, designator)
			pathOfComponent.set(`${inst.id}#${c.i}`, uniquePath)
			components.push({ ...c, id: `${inst.id}#${c.i}`, instanceId: inst.id, designator, logicalDesignator: c.designator, uniquePath })
		}

	// Gather the global nets.
	interface Draft {
		occurrences: NetOccurrence[]
		pins: { component: string; pin: string; path: string }[]
		powers: string[]
		labels: { name: string; depth: number }[]
		ports: { name: string; depth: number }[]
		harness?: { bundle: string; member: string }
		channels: Set<string>
		onChannelFreeSheet: boolean
	}
	const drafts = new Map<string, Draft>()
	const netAtKeys: { inst: string; i: number; root: string }[] = []
	for (const inst of instances) {
		const c = connectivityOf(inst.docPath)
		const sheet = sheets.get(inst.docPath)
		const pinOf = new Map(sheet?.objects.filter(o => o.kind === "pin").map(o => [o.i, o]) ?? [])
		const d = depth(inst)
		for (const net of c.nets) {
			const key = netKey(inst.id, net.id)
			const root = nets.find(key)
			let draft = drafts.get(root)
			if (!draft) {
				draft = { occurrences: [], pins: [], powers: [], labels: [], ports: [], channels: new Set(), onChannelFreeSheet: false }
				drafts.set(root, draft)
			}
			draft.occurrences.push({ instanceId: inst.id, objects: net.objects })
			for (const p of net.pins) {
				const pin = pinOf.get(p)
				if (pin?.kind === "pin")
					draft.pins.push({ component: designatorOf.get(`${inst.id}#${pin.component}`) ?? "", pin: pin.designator, path: pathOfComponent.get(`${inst.id}#${pin.component}`) ?? "" })
			}
			draft.powers.push(...net.powers)
			draft.labels.push(...net.labels.map(name => ({ name, depth: d })))
			draft.ports.push(...net.ports.map(name => ({ name, depth: d })))
			draft.harness ??= memberOf.get(key)
			if (inst.channel) draft.channels.add(inst.channel.name)
			else draft.onChannelFreeSheet = true
			for (const i of net.objects) netAtKeys.push({ inst: inst.id, i, root })
		}
	}

	const shallowest = (list: { name: string; depth: number }[]) =>
		[...list].sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name))[0]?.name
	const result: CompiledNet[] = []
	const idOfRoot = new Map<string, number>()
	for (const [root, d] of drafts) {
		const sortedPins = [...d.pins].sort((a, b) => a.component.localeCompare(b.component, undefined, { numeric: true }) || a.pin.localeCompare(b.pin, undefined, { numeric: true }))
		const channelIndex = d.channels.size === 1 && !d.onChannelFreeSheet ? instances.find(i => i.channel?.name === [...d.channels][0])?.channel?.index : undefined
		const suffix = channelIndex === undefined ? "" : `_${channelIndex}`
		let netName: string
		let physicalName: string
		const power = [...d.powers].sort()[0]
		const named = power ?? shallowest(d.labels) ?? shallowest(d.ports)
		if (named) {
			netName = named
			physicalName = power ? power : named + suffix
		} else if (d.harness) {
			netName = `${bundleName.get(d.harness.bundle)?.name ?? "Harness"}.${d.harness.member}`
			physicalName = netName + suffix
		} else {
			const first = sortedPins[0]
			netName = first ? `Net${first.component}_${first.pin}` : `Net${result.length}`
			physicalName = netName
		}
		if (padNets) {
			const votes = new Map<string, number>()
			for (const p of d.pins) {
				const pcbNet = padNets.get(`${p.path}|${p.pin}`)
				if (pcbNet) votes.set(pcbNet, (votes.get(pcbNet) ?? 0) + 1)
			}
			const best = [...votes].sort((a, b) => b[1] - a[1])[0]
			if (best) physicalName = best[0]
		}
		const names = [...new Set([...d.powers, ...d.labels.map(l => l.name), ...d.ports.map(p => p.name)])]
		idOfRoot.set(root, result.length)
		result.push({ id: result.length, netName, physicalName, names, occurrences: d.occurrences, pins: sortedPins })
	}

	const netAt: Record<string, Record<number, number>> = {}
	for (const { inst, i, root } of netAtKeys) (netAt[inst] ??= {})[i] = idOfRoot.get(root)!
	return { nets: result, components, netAt }
}
