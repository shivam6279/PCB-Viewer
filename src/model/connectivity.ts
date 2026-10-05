// Electrical connectivity within one schematic sheet, following Altium's rules:
// - a wire connects to anything whose hot spot lies on it (its vertices or anywhere along a segment),
//   including another wire's end (a T-junction); wires that merely cross do not connect;
// - pins connect at their tip; coincident hot spots connect directly;
// - net labels, power ports, ports and off-sheet connectors with the same name join on the sheet;
// - signal harnesses form bundles (connector tip + harness wires + harness ports/entries) whose
//   members are the nets attached to the connector's entries.
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

export interface SheetConnectivity {
	nets: LocalNet[]
	netOf: Map<number, number> // object i -> local net id
	harnesses: LocalHarness[]
	harnessOf: Map<number, number> // harness object i -> local harness id
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

	for (const o of sheet.objects) {
		switch (o.kind) {
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

	return { nets, netOf, harnesses, harnessOf }
}
