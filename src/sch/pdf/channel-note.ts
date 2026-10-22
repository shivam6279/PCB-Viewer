// A logical page: one drawing for every instance of a schematic document. Its designators and net
// labels are written with what the instances share and a wildcard (*) for the part each names its own
// way (R1_CAN0, R1_CAN1 -> R1_CAN*); a note above says what * is for each instance. Pure.
import type { CompiledProject } from "../../model/compile"
import type { HierarchyNode } from "../../model/hierarchy"

export const WILDCARD = "*"

// The part several names share before and after where they differ; null when they are all the same.
// A negation marker (the backslash after a character) stays with its character.
export function wildcard(names: string[]): { prefix: string; suffix: string; parts: string[] } | null {
	if (names.length < 2 || names.every(n => n === names[0])) return null
	const first = names[0]!
	let p = 0
	while (p < first.length && names.every(n => n[p] === first[p])) p++
	while (p > 0 && first[p] === "\\") p--
	const shortest = Math.min(...names.map(n => n.length)) - p
	let s = 0
	while (s < shortest && names.every(n => n[n.length - 1 - s] === first[first.length - 1 - s])) s++
	while (s > 0 && first[first.length - s] === "\\") s--
	return { prefix: first.slice(0, p), suffix: first.slice(first.length - s), parts: names.map(n => n.slice(p, n.length - s)) }
}

// Every designator (by its part's record) and net-named object (label, power port: by record) on the
// page, with each instance's name for it.
export function namesPerInstance(members: HierarchyNode[], compiled: CompiledProject): { designators: Map<number, string[]>; nets: Map<number, string[]> } {
	const designators = new Map<number, string[]>()
	const nets = new Map<number, string[]>()
	members.forEach((m, k) => {
		for (const c of compiled.components) if (c.instanceId === m.id) (designators.get(c.i) ?? designators.set(c.i, Array(members.length).fill("")).get(c.i)!)[k] = c.designator
		for (const [i, netId] of Object.entries(compiled.netAt[m.id] ?? {})) {
			const net = compiled.nets[netId]
			if (net) (nets.get(Number(i)) ?? nets.set(Number(i), Array(members.length).fill("")).get(Number(i))!)[k] = net.physicalName
		}
	})
	return { designators, nets }
}

export interface ChannelNote {
	title: string
	channels: { name: string; designators: string; nets: string }[] // what * stands for, per instance
}

// What * stands for in each instance: the varying part most of its designators / net labels have.
export function channelNote(fileName: string, members: HierarchyNode[], compiled: CompiledProject, objects: { designators: number[]; nets: number[] }): ChannelNote {
	const names = namesPerInstance(members, compiled)
	const common = (lists: (string[] | undefined)[], k: number) => {
		const counts = new Map<string, number>()
		for (const list of lists) {
			const w = list && list.every(n => n) ? wildcard(list) : null
			if (w) counts.set(w.parts[k]!, (counts.get(w.parts[k]!) ?? 0) + 1)
		}
		return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
	}
	return {
		title: `${fileName}: one page for its ${members.length} instances. In designators and net labels, ${WILDCARD} is each instance's own part:`,
		channels: members.map((m, k) => ({
			name: m.displayDesignator,
			designators: common(objects.designators.map(i => names.designators.get(i)), k) ?? "",
			nets: common(objects.nets.map(i => names.nets.get(i)), k) ?? "",
		})),
	}
}
