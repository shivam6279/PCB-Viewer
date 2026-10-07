// Electrical connectivity within one schematic sheet, following Altium's rules:
// - a wire connects to anything whose hot spot lies on it (its vertices or anywhere along a segment),
//   including another wire's end (a T-junction); wires that merely cross do not connect;
// - pins connect at their tip; coincident hot spots connect directly;
// - net labels, power ports, ports and off-sheet connectors with the same name join on the sheet;
// - signal harnesses form bundles (connector tip + harness wires + harness ports/entries) whose
//   members are the nets attached to the connector's entries;
// - buses (lines, bus entries, range-named labels/ports/entries) list as members the nets labelled
//   with their elements; bus entries are graphics only, as in Altium.
import type { Pt, SheetData, SheetObject } from "./schematic-data"

export interface LocalNet {
	id: number
	objects: number[]
	pins: number[]
	labels: string[]
	powers: string[]
	ports: string[]
	offsheets: string[]
	entries: { symbol: number; name: string }[]
}

export interface LocalHarness {
	id: number
	objects: number[]
	ports: string[]
	labels: string[] // net labels placed on its harness wires: the harness's name
	entries: { symbol: number; name: string }[]
	members: Map<string, number> // harness entry name -> local net id
}

// A bus: bus lines joined at their vertices, its bus entries, and the range-named labels, ports and
// sheet entries on it ("D[0..7]"). Altium joins buses element by element in order, so members are
// keyed by position in the range: position 0 of "PWM[1..4]" is the net labelled PWM1.
export interface LocalBus {
	id: number
	objects: number[]
	labels: string[]
	ports: string[]
	entries: { symbol: number; name: string }[]
	members: Map<number, number[]> // position -> local net ids
}

export interface SheetConnectivity {
	nets: LocalNet[]
	netOf: Map<number, number> // object i -> local net id
	harnesses: LocalHarness[]
	harnessOf: Map<number, number> // harness object i -> local harness id
	buses: LocalBus[]
	busOf: Map<number, number> // bus object i -> local bus id
}

// "D[0..7]" -> D0 ... D7; "OUT[3..1]" -> OUT3, OUT2, OUT1. Null for a plain name.
export function expandBusName(name: string): string[] | null {
	const m = /^(.*?)\[\s*(\d+)\s*\.\.\s*(\d+)\s*\]$/.exec(name.trim())
	if (!m) return null
	const [from, to] = [Number(m[2]), Number(m[3])]
	const step = from <= to ? 1 : -1
	return Array.from({ length: Math.abs(to - from) + 1 }, (_, k) => `${m[1]}${from + k * step}`)
}

const EPS = 0.01
const key = (p: Pt) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`

class DisjointSet {
	private parent = new Map<number, number>()
	add(a: number) {
		if (!this.parent.has(a)) this.parent.set(a, a)
	}
	find(a: number): number {
		let r = a
		while (this.parent.get(r) !== r) r = this.parent.get(r)!
		let c = a
		while (c !== r) {
			const next = this.parent.get(c)!
			this.parent.set(c, r)
			c = next
		}
		return r
	}
	union(a: number, b: number) {
		this.add(a)
		this.add(b)
		const ra = this.find(a)
		const rb = this.find(b)
		if (ra !== rb) this.parent.set(rb, ra)
	}
}

function onSegment(p: Pt, a: Pt, b: Pt): boolean {
	if (p.x < Math.min(a.x, b.x) - EPS || p.x > Math.max(a.x, b.x) + EPS) return false
	if (p.y < Math.min(a.y, b.y) - EPS || p.y > Math.max(a.y, b.y) + EPS) return false
	return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) <= EPS * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
}

// Joins every hot spot to coincident hot spots and to the lines it lies on.
function connect(set: DisjointSet, hotspots: { i: number; at: Pt }[], lines: { i: number; points: Pt[] }[]) {
	const byPoint = new Map<string, number>()
	for (const h of hotspots) {
		set.add(h.i)
		const k = key(h.at)
		const first = byPoint.get(k)
		if (first === undefined) byPoint.set(k, h.i)
		else set.union(first, h.i)
		for (const line of lines) {
			if (line.i === h.i) continue
			for (let s = 1; s < line.points.length; s++) {
				if (onSegment(h.at, line.points[s - 1]!, line.points[s]!)) {
					set.union(line.i, h.i)
					break
				}
			}
		}
	}
}

export function sheetConnectivity(sheet: SheetData): SheetConnectivity {
	const wires: { i: number; points: Pt[] }[] = []
	const hotspots: { i: number; at: Pt }[] = []
	const netMembers: SheetObject[] = []
	const harnessLines: { i: number; points: Pt[] }[] = []
	const harnessHotspots: { i: number; at: Pt }[] = []
	const harnessObjects: SheetObject[] = []
	const busLines: { i: number; points: Pt[] }[] = []
	const busHotspots: { i: number; at: Pt }[] = []
	const busObjects: SheetObject[] = []
	const byName = new Map<string, number>()
	const set = new DisjointSet()
	const joinByName = (scope: string, name: string, i: number) => {
		const k = `${scope}:${name.toUpperCase()}`
		const first = byName.get(k)
		if (first === undefined) byName.set(k, i)
		else set.union(first, i)
	}

	// A net label sitting on a harness wire names the harness rather than a net.
	const harnessWires = sheet.objects.filter((o): o is Extract<SheetObject, { kind: "harnessWire" }> => o.kind === "harnessWire")
	const onHarnessWire = (p: Pt) => harnessWires.some(w => w.points.some((a, s) => s > 0 && onSegment(p, w.points[s - 1]!, a)))
	// Range-named labels, ports and sheet entries ("D[0..7]") are the bus's, wherever they sit.
	const isBus = (name: string) => expandBusName(name) !== null

	for (const o of sheet.objects) {
		if ((o.kind === "label" && !onHarnessWire(o.at)) || ((o.kind === "port" || o.kind === "entry") && !o.harness)) {
			if (isBus(o.name)) {
				busObjects.push(o)
				for (const at of o.kind === "port" ? o.ends : [o.at]) busHotspots.push({ i: o.i, at })
				continue
			}
		}
		switch (o.kind) {
			case "bus":
				busObjects.push(o)
				busLines.push(o)
				for (const p of o.points) busHotspots.push({ i: o.i, at: p })
				break
			case "busEntry":
				busObjects.push(o)
				for (const p of o.points) busHotspots.push({ i: o.i, at: p })
				break
			case "wire":
				wires.push(o)
				netMembers.push(o)
				set.add(o.i)
				for (const p of o.points) hotspots.push({ i: o.i, at: p })
				break
			case "pin":
				netMembers.push(o)
				hotspots.push({ i: o.i, at: o.hot })
				break
			case "label":
				if (onHarnessWire(o.at)) {
					harnessObjects.push(o)
					harnessHotspots.push({ i: o.i, at: o.at })
					break
				}
				netMembers.push(o)
				hotspots.push({ i: o.i, at: o.at })
				joinByName(o.kind, o.name, o.i)
				break
			case "power":
			case "offsheet":
				netMembers.push(o)
				hotspots.push({ i: o.i, at: o.at })
				joinByName(o.kind, o.name, o.i)
				break
			case "port":
				if (o.harness) {
					harnessObjects.push(o)
					for (const p of o.ends) harnessHotspots.push({ i: o.i, at: p })
				} else {
					netMembers.push(o)
					for (const p of o.ends) hotspots.push({ i: o.i, at: p })
					joinByName("port", o.name, o.i)
				}
				break
			case "entry":
				if (o.harness) {
					harnessObjects.push(o)
					harnessHotspots.push({ i: o.i, at: o.at })
				} else {
					netMembers.push(o)
					hotspots.push({ i: o.i, at: o.at })
				}
				break
			case "harnessWire":
				harnessObjects.push(o)
				harnessLines.push(o)
				for (const p of o.points) harnessHotspots.push({ i: o.i, at: p })
				break
			case "harnessConnector":
				harnessObjects.push(o)
				harnessHotspots.push({ i: o.i, at: o.tip })
				for (const e of o.entries) hotspots.push({ i: e.i, at: e.at })
				break
		}
	}

	connect(set, hotspots, wires)

	// Local nets: one per connected group of net members (and harness connector entry dots).
	const memberIds = [...netMembers.map(o => o.i), ...sheet.objects.flatMap(o => (o.kind === "harnessConnector" ? o.entries.map(e => e.i) : []))]
	const rootToNet = new Map<number, LocalNet>()
	const netOf = new Map<number, number>()
	const nets: LocalNet[] = []
	const netFor = (i: number) => {
		set.add(i)
		const root = set.find(i)
		let net = rootToNet.get(root)
		if (!net) {
			net = { id: nets.length, objects: [], pins: [], labels: [], powers: [], ports: [], offsheets: [], entries: [] }
			rootToNet.set(root, net)
			nets.push(net)
		}
		netOf.set(i, net.id)
		return net
	}
	for (const i of memberIds) netFor(i).objects.push(i)
	const addName = (list: string[], name: string) => {
		if (!list.some(n => n.toUpperCase() === name.toUpperCase())) list.push(name)
	}
	for (const o of netMembers) {
		const net = nets[netOf.get(o.i)!]!
		if (o.kind === "pin") net.pins.push(o.i)
		else if (o.kind === "label") addName(net.labels, o.name)
		else if (o.kind === "power") addName(net.powers, o.name)
		else if (o.kind === "port") addName(net.ports, o.name)
		else if (o.kind === "offsheet") addName(net.offsheets, o.name)
		else if (o.kind === "entry") net.entries.push({ symbol: o.symbol, name: o.name })
	}

	// Harness bundles.
	const hset = new DisjointSet()
	connect(hset, harnessHotspots, harnessLines)
	const harnesses: LocalHarness[] = []
	const harnessOf = new Map<number, number>()
	const rootToHarness = new Map<number, LocalHarness>()
	for (const o of harnessObjects) {
		hset.add(o.i)
		const root = hset.find(o.i)
		let h = rootToHarness.get(root)
		if (!h) {
			h = { id: harnesses.length, objects: [], ports: [], labels: [], entries: [], members: new Map() }
			rootToHarness.set(root, h)
			harnesses.push(h)
		}
		harnessOf.set(o.i, h.id)
		h.objects.push(o.i)
		if (o.kind === "port") addName(h.ports, o.name)
		else if (o.kind === "label") addName(h.labels, o.name)
		else if (o.kind === "entry") h.entries.push({ symbol: o.symbol, name: o.name })
		else if (o.kind === "harnessConnector") for (const e of o.entries) h.members.set(e.name, netOf.get(e.i)!)
	}

	// Buses, and their members: the nets labelled with each element name of each range on the bus.
	const netsByName = new Map<string, number[]>()
	for (const net of nets)
		for (const name of [...net.labels, ...net.ports]) {
			const k = name.toUpperCase()
			;(netsByName.get(k) ?? netsByName.set(k, []).get(k)!).push(net.id)
		}
	const bset = new DisjointSet()
	connect(bset, busHotspots, busLines)
	// Equal bus labels on one sheet join their buses, as equal net labels join nets.
	const busLabel = new Map<string, number>()
	for (const o of busObjects) {
		if (o.kind !== "label") continue
		const k = o.name.toUpperCase().replace(/\s+/g, "")
		const first = busLabel.get(k)
		if (first === undefined) busLabel.set(k, o.i)
		else bset.union(first, o.i)
	}
	const buses: LocalBus[] = []
	const busOf = new Map<number, number>()
	const rootToBus = new Map<number, LocalBus>()
	for (const o of busObjects) {
		bset.add(o.i)
		const root = bset.find(o.i)
		let b = rootToBus.get(root)
		if (!b) {
			b = { id: buses.length, objects: [], labels: [], ports: [], entries: [], members: new Map() }
			rootToBus.set(root, b)
			buses.push(b)
		}
		busOf.set(o.i, b.id)
		b.objects.push(o.i)
		if (o.kind === "label") addName(b.labels, o.name)
		else if (o.kind === "port") addName(b.ports, o.name)
		else if (o.kind === "entry") b.entries.push({ symbol: o.symbol, name: o.name })
	}
	for (const b of buses)
		for (const name of [...b.labels, ...b.ports, ...b.entries.map(e => e.name)])
			expandBusName(name)?.forEach((element, k) => {
				for (const netId of netsByName.get(element.toUpperCase()) ?? []) {
					const list = b.members.get(k) ?? b.members.set(k, []).get(k)!
					if (!list.includes(netId)) list.push(netId)
				}
			})

	return { nets, netOf, harnesses, harnessOf, buses, busOf }
}
