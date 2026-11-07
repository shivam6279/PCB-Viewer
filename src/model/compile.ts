// Project-wide net compilation: joins every sheet instance's local nets into the project's nets, for a
// hierarchical, multi-channel design. Checked against every board of the corpus (tests/corpus).
// - the project's net identifier scope (HierarchyMode, see NetScope) decides what joins across sheets:
//   ports join their parent's sheet entries; power ports join project-wide (on their own sheet only
//   in strict scope); flat scope joins ports project-wide, global scope also net labels;
// - off-sheet connectors join by name across the sheets placed beside each other (the same parent, or
//   project-wide in a flat or global design);
// - signal harness members join across levels by entry name; a member may be a bus (DATA[0..3]);
// - bus ports join the parent's bus entries like ports do, and bus members join element by element
//   in range order (position k of "PWM[1..4]" on one side is position k on the other);
// - each channel instance gets its own copies of the nets that live inside it: REPEAT symbols, and a
//   sheet placed by several sheet symbols (numbered in the natural order of their designators);
// - a "Repeat(P)" entry on a REPEAT symbol gives each channel its own net: channel k's port P joins the
//   parent net named <name>k, where <name> labels the wire on the entry (PWMH -> PWMH1, PWMH2, ...),
//   whether that is a net of its own or an element of a bus ("PWMH[1..3]"). The wire itself is no net:
//   it is the bus of those nets.
// Naming (chooseNetName, from the project's naming options): every name a net carries is a candidate
// (power port, net label, port, sheet entry, harness member "<harness>.<member>", Repeat element); a
// name given inside a channel reads with the channel designator format (formatNetName); with no
// candidate the net is "Net<designator>_<pin>". The other names stay on the net as aliases.
import { expandBusName, sheetConnectivity, type SheetConnectivity } from "./connectivity"
import { parseRepeat, type HierarchyNode } from "./hierarchy"
import type { Parameter, SheetData, SheetSymbol } from "./schematic-data"

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
	aliases: NetAlias[] // its names other than the physical one, with the sheet instances that use each
	occurrences: NetOccurrence[]
	pins: { component: string; pin: string; path: string }[] // physical designator, pin designator, component source path
	nameCandidates?: NameCandidate[] // every name it could take, where (the physical name is chosen from these)
}

// A name a net could take: a power port, net label (or off-sheet connector, or a Repeat entry's
// element), port, sheet entry or harness member ("I2C.SDA"), on a sheet at some depth.
export interface NameCandidate {
	name: string
	kind: "power" | "label" | "repeat" | "port" | "entry" | "harness"
	depth: number
	instanceId: string
	channel: { index: number; name: string } | null
	docOrder: number // its sheet's place in the project's document list
	bundleNamedBy?: "label" | "port" // a harness member: what names its harness (a label on it, else its ports/entries)
}

const KIND_RANK: Record<NameCandidate["kind"], number> = { label: 1, repeat: 1, harness: 1, power: 2, port: 3, entry: 4 }
// A harness named by a label on its wires names its members as net labels do; one named only by its
// ports and sheet entries ranks with ports.
const rankOf = (c: NameCandidate) => (c.kind !== "harness" ? KIND_RANK[c.kind] : c.bundleNamedBy === "label" ? KIND_RANK.label : KIND_RANK.port)

// Names compare by character code (upper case before lower, "1" before "_").
function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

// The net's name by the project's naming options, checked against every board in the corpus:
// - power port names first when they take priority;
// - then by kind (net label / Repeat element / label-named harness, power port, port, sheet entry);
// - with higher-level names taking priority, the highest sheet's name;
// - a name given outside any channel before one inside a channel;
// - with higher-level names taking priority, the sheet listed first in the project;
// - then the first alphabetically, as the name will read (with its channel).

export function chooseNetName(candidates: NameCandidate[], naming: NetNaming, scope: string, format = ""): NameCandidate | undefined {
	// Sheet entries name nets only where ports may too (no board here with ports off names by an entry).
	let pool = candidates.filter(c => (rankOf(c) !== KIND_RANK.port || naming.ports) && (c.kind !== "entry" || (naming.entries && naming.ports)))
	if (naming.powerFirst && pool.some(c => c.kind === "power")) pool = pool.filter(c => c.kind === "power")
	const level = naming.higherLevelFirst ? 1 : 0
	const read = (c: NameCandidate) => (c.kind === "power" && scope !== "strict" ? c.name : formatNetName(c.name, c.channel, format))
	const inChannel = (c: NameCandidate) => (c.channel ? 1 : 0)
	return [...pool].sort(
		(a, b) =>
			rankOf(a) - rankOf(b) ||
			level * (a.depth - b.depth) ||
			inChannel(a) - inChannel(b) ||
			level * (a.docOrder - b.docOrder) ||
			compareNames(read(a), read(b)),
	)[0]
}

// A name a net carries on some sheets that is not its physical name (a sub-block's own "VIN" for 5V).
export interface NetAlias {
	name: string
	instanceIds: string[]
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
	libraryItem?: string
	kind?: number
}

// A bus or signal harness, joined across sheets: its own graphics and the nets it carries.
export interface CompiledBundle {
	id: number
	kind: "bus" | "harness"
	name: string
	occurrences: NetOccurrence[] // its bus lines / harness wires, connectors, labels, ports, entries
	nets: number[] // member nets
}

export interface CompiledProject {
	nets: CompiledNet[]
	components: CompiledComponent[]
	netAt: Record<string, Record<number, number>> // instance id -> object i -> net id
	bundles: CompiledBundle[]
	bundleAt: Record<string, Record<number, number>> // instance id -> object i -> bundle id
	netBundles: Record<number, number[]> // net id -> the bundles carrying it
}

export interface CompileInput {
	instances: CompileInstance[]
	sheets: Map<string, SheetData>
	designatorFormat: string
	// Optional PCB truth: "<component source path>|<pad>" -> PCB net name, used for physical names.
	padNets?: Map<string, string>
	// Optional PCB truth: component source path -> the board's (physical) designator. The board's
	// annotation wins over the channel format: a sheet placed by several sheet symbols, or a board
	// annotated on its own, has designators the format does not give.
	boardDesignators?: Map<string, string>
	// The project's net identifier scope (its HierarchyMode); "automatic" when there is no project file.
	netScope?: NetScope
	// The project's net naming options; defaults when there is no project file.
	naming?: Partial<NetNaming>
}

// The .PrjPcb's net naming options.
export interface NetNaming {
	ports: boolean // AllowPortNetNames: ports may name nets
	entries: boolean // AllowSheetEntryNetNames: sheet entries may name nets
	higherLevelFirst: boolean // NameNetsHierarchically: a name on a higher sheet wins
	powerFirst: boolean // PowerPortNamesTakePriority: power port names win over net labels
	sheetNumbers: boolean // AppendSheetNumberToLocalNets
}

const DEFAULT_NAMING: NetNaming = { ports: true, entries: true, higherLevelFirst: true, powerFirst: true, sheetNumbers: false }

export function netNamingOf(projectText: string): NetNaming {
	const flag = (key: string, fallback: boolean) => {
		const v = new RegExp("^" + key + "=(\\d+)", "m").exec(projectText)?.[1]
		return v === undefined ? fallback : v !== "0"
	}
	return {
		ports: flag("AllowPortNetNames", DEFAULT_NAMING.ports),
		entries: flag("AllowSheetEntryNetNames", DEFAULT_NAMING.entries),
		higherLevelFirst: flag("NameNetsHierarchically", DEFAULT_NAMING.higherLevelFirst),
		powerFirst: flag("PowerPortNamesTakePriority", DEFAULT_NAMING.powerFirst),
		sheetNumbers: flag("AppendSheetNumberToLocalNets", DEFAULT_NAMING.sheetNumbers),
	}
}

// How names join across sheets. Flat: ports join project-wide. Global: ports and net labels do.
// Hierarchical: ports join only their sheet entries; power ports join project-wide. Strict: the same,
// but power ports join only on their own sheet. Automatic: hierarchical when a top sheet has sheet
// entries, else flat when any sheet has ports, else global.
export type NetScope = "automatic" | "flat" | "hierarchical" | "strict" | "global"

// The .PrjPcb's HierarchyMode: 0 automatic, 1 flat, 2 hierarchical, 3 global, 4 strict hierarchical.
export function netScopeOf(projectText: string): NetScope {
	const mode = Number(/^HierarchyMode=(\d+)/m.exec(projectText)?.[1] ?? 0)
	return (["automatic", "flat", "hierarchical", "global", "strict"] as const)[mode] ?? "automatic"
}

// "Repeat(IN)" -> "IN"; null for any other entry name.
function repeatEntryPort(name: string): string | null {
	return /^\s*repeat\s*\(\s*([^()]+?)\s*\)\s*$/i.exec(name)?.[1] ?? null
}

export function formatDesignator(designator: string, channel: { index: number; name: string } | null, format: string): string {
	if (!channel) return designator
	return format
		.replaceAll("$Component", designator)
		.replaceAll("$ChannelIndex", String(channel.index))
		.replaceAll("$ChannelAlpha", String.fromCharCode(64 + channel.index))
		.replaceAll("$RoomName", channel.name)
		.replaceAll("$ChannelPrefix", channel.name)
}

// A net name inside a channel, by the channel designator format with the net's name for $Component.
// When the format writes the channel by name ($RoomName, $ChannelPrefix), a name ending in _H, _L, _P or
// _N keeps that ending last: CAN_H in channel CAN0 is CAN_CAN0_H. (Seen on every board here that names
// its channels; boards that number them append: RST_L_2.)
export function formatNetName(name: string, channel: { index: number; name: string } | null, format: string): string {
	if (!channel) return name
	const ending = /^(.+)(_[HLPN])$/i.exec(name)
	if (ending && /\$(RoomName|ChannelPrefix)/.test(format)) return formatDesignator(ending[1]!, channel, format) + ending[2]
	return formatDesignator(name, channel, format)
}

// Every sheet instance of the project hierarchy, with its parent and (inherited) channel.
export function compileInstances(hierarchy: HierarchyNode[]): CompileInstance[] {
	const out: CompileInstance[] = []
	// A sheet placed by several sheet symbols (anywhere in the project) is multi-channel too: its channels
	// are those symbols, numbered in the natural order of their designators (MW_12V before MW_120V; equal
	// designators, unannotated copies, in file order).
	const symbolKey = (node: HierarchyNode, parentDoc: string) => `${parentDoc}|${node.id.split("/").pop()}`
	const placements = new Map<string, { key: string; designator: string }[]>() // file -> its distinct symbols
	const collect = (node: HierarchyNode) => {
		if (!node.docPath || node.cyclic) return
		for (const child of node.children) {
			if (child.docPath && child.channel === null && child.designator) {
				const list = placements.get(child.docPath) ?? placements.set(child.docPath, []).get(child.docPath)!
				const key = symbolKey(child, node.docPath)
				if (!list.some(p => p.key === key)) list.push({ key, designator: child.designator })
			}
			collect(child)
		}
	}
	hierarchy.forEach(collect)
	const placedIndex = new Map<string, number>()
	for (const list of placements.values()) {
		if (list.length < 2) continue
		const sorted = [...list].sort((a, b) => a.designator.localeCompare(b.designator, "en", { numeric: true }))
		sorted.forEach((p, k) => placedIndex.set(p.key, k + 1))
	}
	const visit = (node: HierarchyNode, parent: CompileInstance | null, parentDoc: string) => {
		if (!node.docPath || node.cyclic) return
		const placed = node.channel === null && node.designator ? placedIndex.get(symbolKey(node, parentDoc)) : undefined
		const channel =
			node.channel !== null && node.designator
				? { index: node.channel, name: node.designator }
				: placed !== undefined
					? { index: placed, name: node.designator! }
					: (parent?.channel ?? null)
		const inst: CompileInstance = { id: node.id, docPath: node.docPath, parentId: parent?.id ?? null, designator: node.designator, channel }
		out.push(inst)
		for (const child of node.children) visit(child, inst, node.docPath)
	}
	for (const root of hierarchy) visit(root, null, "")
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

export function compileProject({ instances, sheets, designatorFormat, padNets, boardDesignators, netScope = "automatic", naming: namingInput }: CompileInput): CompiledProject {
	const naming: NetNaming = { ...DEFAULT_NAMING, ...namingInput }
	const local = new Map<string, SheetConnectivity>()
	const connectivityOf = (docPath: string) => {
		let c = local.get(docPath)
		if (!c) local.set(docPath, (c = sheetConnectivity(sheets.get(docPath) ?? { objects: [], components: [], symbols: [] })))
		return c
	}
	const byId = new Map(instances.map(inst => [inst.id, inst]))
	const depth = (inst: CompileInstance): number => (inst.parentId ? 1 + depth(byId.get(inst.parentId)!) : 0)
	const netKey = (inst: string, id: number) => `${inst}#${id}`
	const busKey = (inst: string, id: number) => `bus:${inst}#${id}`
	const nets = new Union()
	const bundles = new Union()

	const scope =
		netScope !== "automatic"
			? netScope
			: instances.some(i => !i.parentId && sheets.get(i.docPath)?.objects.some(o => o.kind === "entry"))
				? "hierarchical"
				: instances.some(i => sheets.get(i.docPath)?.objects.some(o => o.kind === "port"))
					? "flat"
					: "global"
	const projectWide = scope === "flat" || scope === "global"
	// Names joined by key: every net carrying a name with the same key is one net.
	const joinKeys = new Map<string, string>()
	const joinKey = (k: string, net: string) => {
		const first = joinKeys.get(k)
		if (first) nets.union(first, net)
		else joinKeys.set(k, net)
	}
	for (const inst of instances)
		for (const net of connectivityOf(inst.docPath).nets) {
			const k = netKey(inst.id, net.id)
			nets.find(k)
			for (const name of net.powers) joinKey(`power|${scope === "strict" ? inst.id : ""}|${name.toUpperCase()}`, k)
			// Off-sheet connectors: project-wide in a flat or global design, else between sibling sheets.
			for (const name of net.offsheets) joinKey(`offsheet|${projectWide ? "" : (inst.parentId ?? "")}|${name.toUpperCase()}`, k)
			if (projectWide) for (const name of net.ports) joinKey(`port|${name.toUpperCase()}`, k)
			if (scope === "global") for (const name of net.labels) joinKey(`label|${name.toUpperCase()}`, k)
		}

	// Vertical connections: child ports <-> the parent's sheet entries on the symbol that placed it.
	// Also builds each instance's unique path (symbol ids, a REPEAT symbol's prefixed by the channel).
	const pathOf = new Map<string, string>()
	for (const inst of instances) if (!inst.parentId) pathOf.set(inst.id, "")
	// A sheet can place the same file twice under one designator (an unannotated copy): the children,
	// in order, take those symbols in order, so each copy gets its own path. A REPEAT symbol places all
	// its channels.
	const claimed = new Set<SheetSymbol>()
	const repeatJoins: { childKey: string; parentId: string; parentKey: string; base: string; element: string; index: number }[] = []
	const fileOf = (path: string) => (path.split(/[\\/]/).pop() ?? "").toLowerCase()
	for (const child of instances) {
		if (!child.parentId || !child.designator) continue
		const parent = byId.get(child.parentId)!
		const parentSheet = sheets.get(parent.docPath)
		const exact = parentSheet?.symbols.filter(s => s.designator === child.designator) ?? []
		const symbol =
			exact.find(s => !claimed.has(s) && fileOf(s.fileName) === fileOf(child.docPath)) ??
			exact.find(s => !claimed.has(s)) ??
			exact[0] ??
			parentSheet?.symbols.find(s => {
				const r = parseRepeat(s.designator)
				return r !== null && Array.from({ length: r.last - r.first + 1 }, (_, k) => `${r.name}${r.first + k}`).includes(child.designator!)
			})
		if (!symbol) continue
		if (exact.includes(symbol)) claimed.add(symbol)
		const channelPrefix = parseRepeat(symbol.designator) && child.channel?.name === child.designator ? String(child.channel.index) : ""
		pathOf.set(child.id, `${pathOf.get(parent.id) ?? ""}\\${channelPrefix}${symbol.uniqueId}`)
		const pc = connectivityOf(parent.docPath)
		const cc = connectivityOf(child.docPath)
		const repeat = parseRepeat(symbol.designator)
		const channelIndex = repeat && child.designator.toUpperCase().startsWith(repeat.name.toUpperCase()) ? Number(child.designator.slice(repeat.name.length)) : NaN
		for (const cnet of cc.nets)
			for (const port of cnet.ports)
				for (const pnet of pc.nets) {
					if (pnet.entries.some(e => e.symbol === symbol.i && e.name.toUpperCase() === port.toUpperCase()))
						nets.union(netKey(child.id, cnet.id), netKey(parent.id, pnet.id))
					if (Number.isFinite(channelIndex) && pnet.entries.some(e => e.symbol === symbol.i && repeatEntryPort(e.name)?.toUpperCase() === port.toUpperCase())) {
						const base = [...pnet.labels, ...pnet.offsheets, ...pnet.ports][0]
						if (base) repeatJoins.push({ childKey: netKey(child.id, cnet.id), parentId: parent.id, parentKey: netKey(parent.id, pnet.id), base, element: `${base}${channelIndex}`, index: channelIndex })
						else nets.union(netKey(child.id, cnet.id), netKey(parent.id, pnet.id))
					}
				}
		for (const ch of cc.harnesses)
			for (const port of ch.ports)
				for (const ph of pc.harnesses)
					if (ph.entries.some(e => e.symbol === symbol.i && e.name.toUpperCase() === port.toUpperCase()))
						bundles.union(netKey(child.id, ch.id), netKey(parent.id, ph.id))
		for (const cb of cc.buses)
			for (const port of cb.ports)
				for (const pb of pc.buses)
					if (pb.entries.some(e => e.symbol === symbol.i && e.name.toUpperCase() === port.toUpperCase()))
						bundles.union(busKey(child.id, cb.id), busKey(parent.id, pb.id))
	}

	// Every bus and harness as one object: its graphics on each sheet and the nets it carries.
	interface BundleDraft {
		kind: "bus" | "harness"
		occurrences: NetOccurrence[]
		netKeys: string[]
		name: { name: string; depth: number; rank: number } | null
		ordered?: boolean // its nets are listed in order already (a Repeat bus: channel order)
	}
	const bundleDrafts = new Map<string, BundleDraft>()
	const bundleDraft = (root: string, kind: "bus" | "harness") => {
		let draft = bundleDrafts.get(root)
		if (!draft) bundleDrafts.set(root, (draft = { kind, occurrences: [], netKeys: [], name: null }))
		return draft
	}

	// Bus members: within each unified bus, the nets at the same position are one net.
	const busMembers = new Map<string, string>() // `${bus root}|${position}` -> first net key
	for (const inst of instances) {
		const c = connectivityOf(inst.docPath)
		const d = depth(inst)
		for (const b of c.buses) {
			const root = bundles.find(busKey(inst.id, b.id))
			const draft = bundleDraft(root, "bus")
			draft.occurrences.push({ instanceId: inst.id, objects: b.objects })
			// A label on the bus names it; otherwise its ports/entries do. Highest level wins.
			for (const { name, rank } of [...b.labels.map(name => ({ name, rank: 0 })), ...[...b.ports, ...b.entries.map(e => e.name)].map(name => ({ name, rank: 1 }))])
				if (!draft.name || d < draft.name.depth || (d === draft.name.depth && rank < draft.name.rank)) draft.name = { name, depth: d, rank }
			for (const [position, ids] of b.members)
				for (const id of ids) {
					const k = netKey(inst.id, id)
					draft.netKeys.push(k)
					const slot = `${root}|${position}`
					const first = busMembers.get(slot)
					if (first) nets.union(first, k)
					else busMembers.set(slot, k)
				}
		}
	}

	// Repeat entries: each channel's net joins the parent's net or bus element of its channel's name.
	for (const { childKey, parentId, element } of repeatJoins) {
		const parent = byId.get(parentId)!
		const pc = connectivityOf(parent.docPath)
		const name = element.toUpperCase()
		for (const pnet of pc.nets)
			if ([...pnet.labels, ...pnet.offsheets, ...pnet.ports].some(n => n.toUpperCase() === name)) nets.union(childKey, netKey(parentId, pnet.id))
		for (const b of pc.buses)
			for (const busName of [...b.labels, ...b.ports, ...b.entries.map(e => e.name)]) {
				const position = expandBusName(busName)?.findIndex(n => n.toUpperCase() === name) ?? -1
				if (position < 0) continue
				const slot = `${bundles.find(busKey(parentId, b.id))}|${position}`
				const first = busMembers.get(slot)
				if (first) nets.union(first, childKey)
				else busMembers.set(slot, childKey)
			}
	}

	// Harness members: within each unified bundle, entries with the same name are one net.
	const bundleMembers = new Map<string, Map<string, string>>() // bundle root -> member -> first net key
	const bundleName = new Map<string, { name: string; depth: number; rank: number; instanceId: string }>()
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
				if (!best || d < best.depth || (d === best.depth && rank < best.rank)) bundleName.set(root, { name, depth: d, rank, instanceId: inst.id })
			}
			for (const [member, netId] of h.members) joinMember(root, member, netKey(inst.id, netId))
			bundleDraft(root, "harness").occurrences.push({ instanceId: inst.id, objects: h.objects })
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
			const designator = boardDesignators?.get(uniquePath) || formatDesignator(c.designator, inst.channel, designatorFormat)
			designatorOf.set(`${inst.id}#${c.i}`, designator)
			pathOfComponent.set(`${inst.id}#${c.i}`, uniquePath)
			components.push({ ...c, id: `${inst.id}#${c.i}`, instanceId: inst.id, designator, logicalDesignator: c.designator, uniquePath })
		}

	// Gather the global nets, with every name each one could take.
	interface Draft {
		occurrences: NetOccurrence[]
		pins: { component: string; pin: string; path: string }[]
		used: Map<string, Set<string>> // name -> the instances it is written on
		candidates: NameCandidate[]
		repeatStub: boolean // on a Repeat entry's wire: the channels' nets in one, not a net
	}
	const drafts = new Map<string, Draft>()
	const docOrder = new Map([...sheets.keys()].map((path, k) => [path, k]))
	const netAtKeys: { inst: string; i: number; root: string }[] = []
	const repeatOf = new Map<string, { element: string; parentId: string }[]>() // child net key -> its Repeat elements
	for (const j of repeatJoins) (repeatOf.get(j.childKey) ?? repeatOf.set(j.childKey, []).get(j.childKey)!).push(j)
	const repeatStubKeys = new Map<string, { base: string; childKeys: string[]; indices: number[] }>()
	for (const j of repeatJoins) {
		const stub = repeatStubKeys.get(j.parentKey) ?? repeatStubKeys.set(j.parentKey, { base: j.base, childKeys: [], indices: [] }).get(j.parentKey)!
		stub.childKeys.push(j.childKey)
		stub.indices.push(j.index)
	}
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
				draft = { occurrences: [], pins: [], used: new Map(), candidates: [], repeatStub: false }
				drafts.set(root, draft)
			}
			draft.occurrences.push({ instanceId: inst.id, objects: net.objects })
			for (const p of net.pins) {
				const pin = pinOf.get(p)
				if (pin?.kind === "pin")
					draft.pins.push({ component: designatorOf.get(`${inst.id}#${pin.component}`) ?? "", pin: pin.designator, path: pathOfComponent.get(`${inst.id}#${pin.component}`) ?? "" })
			}
			if (repeatStubKeys.has(key)) draft.repeatStub = true
			// A sheet entry with nothing wired to it on this sheet does not name the net.
			const unwired = net.objects.length === net.entries.length
			const entries = unwired ? [] : net.entries.map(e => e.name).filter(n => !repeatEntryPort(n))
			const add = (name: string, kind: NameCandidate["kind"], at: CompileInstance, depthAt = depth(at)) =>
				draft!.candidates.push({ name, kind, depth: depthAt, instanceId: at.id, channel: at.channel, docOrder: docOrder.get(at.docPath) ?? 0 })
			for (const name of net.powers) add(name, "power", inst)
			// An off-sheet connector's name names the net as a net label does.
			for (const name of [...net.labels, ...net.offsheets]) add(name, "label", inst)
			for (const name of net.ports) add(name, "port", inst)
			for (const name of entries) add(name, "entry", inst)
			const member = memberOf.get(key)
			if (member) {
				const bundle = bundleName.get(member.bundle)
				const owner = bundle ? byId.get(bundle.instanceId) ?? inst : inst
				add(`${bundle?.name ?? "Harness"}.${member.member}`, "harness", owner, bundle?.depth ?? d)
				draft.candidates[draft.candidates.length - 1]!.bundleNamedBy = bundle?.rank === 0 ? "label" : "port"
			}
			// A Repeat entry's element (PWMH -> PWMH2) names the channel's net from the parent sheet.
			for (const r of repeatOf.get(key) ?? []) add(r.element, "repeat", byId.get(r.parentId)!)
			for (const name of [...net.powers, ...net.labels, ...net.offsheets, ...net.ports, ...entries]) {
				if (!draft.used.has(name)) draft.used.set(name, new Set())
				draft.used.get(name)!.add(inst.id)
			}
			for (const i of net.objects) netAtKeys.push({ inst: inst.id, i, root })
		}
	}

	const result: CompiledNet[] = []
	const idOfRoot = new Map<string, number>()
	for (const [root, d] of drafts) {
		if (d.repeatStub && d.pins.length === 0) continue
		const sortedPins = [...d.pins].sort((a, b) => a.component.localeCompare(b.component, undefined, { numeric: true }) || a.pin.localeCompare(b.pin, undefined, { numeric: true }))
		const chosen = chooseNetName(d.candidates, naming, scope, designatorFormat)
		let netName: string
		let physicalName: string
		if (chosen) {
			netName = chosen.name
			// A name given inside a channel takes the channel's suffix; power port names are global.
			physicalName = chosen.kind === "power" && scope !== "strict" ? chosen.name : formatNetName(chosen.name, chosen.channel, designatorFormat)
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
		const names = [...new Set(d.candidates.filter(c => c.kind !== "harness").map(c => c.name))]
		const aliases = [...d.used]
			.filter(([name]) => name.toUpperCase() !== physicalName.toUpperCase())
			.map(([name, ids]) => ({ name, instanceIds: [...ids] }))
			.sort((a, b) => a.name.localeCompare(b.name))
		idOfRoot.set(root, result.length)
		result.push({ id: result.length, netName, physicalName, names, aliases, occurrences: d.occurrences, pins: sortedPins, nameCandidates: d.candidates })
	}

	// A Repeat entry's wire carries one net per channel: it is drawn as their bus.
	for (const [root, d] of drafts) {
		if (!d.repeatStub || d.pins.length > 0) continue
		const keys = [...repeatStubKeys].filter(([k]) => nets.find(k) === root)
		const indices = keys.flatMap(([, v]) => v.indices)
		const base = keys[0] ? `${keys[0][1].base}[${Math.min(...indices)}..${Math.max(...indices)}]` : "Bus"
		// Its nets in channel order.
		const ordered = keys.flatMap(([, v]) => v.childKeys.map((k, n) => ({ k, index: v.indices[n]! }))).sort((a, b) => a.index - b.index)
		bundleDrafts.set(`repeat:${root}`, { kind: "bus", occurrences: d.occurrences, netKeys: ordered.map(o => o.k), name: { name: base, depth: 0, rank: 0 }, ordered: true })
	}

	const netAt: Record<string, Record<number, number>> = {}
	for (const { inst, i, root } of netAtKeys) {
		const id = idOfRoot.get(root)
		if (id !== undefined) (netAt[inst] ??= {})[i] = id
	}

	const bundleList: CompiledBundle[] = []
	const bundleAt: Record<string, Record<number, number>> = {}
	const netBundles: Record<number, number[]> = {}
	for (const [k, m] of memberOf) bundleDrafts.get(m.bundle)?.netKeys.push(k)
	for (const [root, draft] of bundleDrafts) {
		const id = bundleList.length
		const name = draft.kind === "harness" ? (bundleName.get(root)?.name ?? "Harness") : (draft.name?.name ?? "Bus")
		const members = [...new Set(draft.netKeys.map(k => idOfRoot.get(nets.find(k))).filter((n): n is number => n !== undefined))]
		if (!draft.ordered) members.sort((a, b) => a - b)
		bundleList.push({ id, kind: draft.kind, name, occurrences: draft.occurrences, nets: members })
		for (const o of draft.occurrences) for (const i of o.objects) (bundleAt[o.instanceId] ??= {})[i] = id
		for (const n of members) (netBundles[n] ??= []).push(id)
	}
	return { nets: result, components, netAt, bundles: bundleList, bundleAt, netBundles }
}
