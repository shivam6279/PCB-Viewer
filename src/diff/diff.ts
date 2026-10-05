// Comparing two commits of a project: which documents changed (by git blob sha), and within a board
// or a sheet, which objects exist in only one of the two. Pure: no DOM, no Altium parsing here.
import type { PcbObject, Prim } from "../pcb/scene"

export type FileChange = "modified" | "added" | "removed"

// Document paths that differ: sha present in only one, or different shas.
export function fileChanges(a: Map<string, string>, b: Map<string, string>, paths: Iterable<string>): Map<string, FileChange> {
	const out = new Map<string, FileChange>()
	for (const p of paths) {
		const sa = a.get(p), sb = b.get(p)
		if (sa === undefined && sb === undefined) continue
		if (sa === undefined) out.set(p, "added")
		else if (sb === undefined) out.set(p, "removed")
		else if (sa !== sb) out.set(p, "modified")
	}
	return out
}

export interface ObjectDiff {
	onlyA: Set<number> // indices into A's list
	onlyB: Set<number>
	total: number // objects in A and B together, for the "most of it changed" check
}

// Multiset difference by fingerprint: an object counts as unchanged while B still has one with the same
// fingerprint; a moved or edited object is then one removed (A) plus one added (B).
export function diffByKey<T>(a: T[], b: T[], key: (t: T) => string): ObjectDiff {
	// Duplicates pair up in order: the first in A with the first in B.
	const pool = new Map<string, { list: number[]; next: number }>()
	b.forEach((t, i) => {
		const k = key(t)
		let entry = pool.get(k)
		if (!entry) pool.set(k, (entry = { list: [], next: 0 }))
		entry.list.push(i)
	})
	const onlyA = new Set<number>()
	a.forEach((t, i) => {
		const entry = pool.get(key(t))
		if (entry && entry.next < entry.list.length) entry.next++
		else onlyA.add(i)
	})
	const onlyB = new Set<number>()
	for (const { list, next } of pool.values()) for (let j = next; j < list.length; j++) onlyB.add(list[j]!)
	return { onlyA, onlyB, total: a.length + b.length }
}

// More than half of everything is on one side: a board-wide change (an origin move, a re-pour) that
// painted in full would hide whatever else changed.
export const mostlyChanged = (d: ObjectDiff) => d.total > 0 && (d.onlyA.size + d.onlyB.size) / d.total > 0.5

const r = (v: number) => Math.round(v * 100) / 100 // 0.01 mil: float noise between saves is not a change

function primKey(p: Prim): string {
	switch (p.t) {
		case "seg":
			return `s${r(p.x1)},${r(p.y1)},${r(p.x2)},${r(p.y2)},${r(p.w)}`
		case "arc":
			return `a${r(p.x)},${r(p.y)},${r(p.r)},${r(p.a0)},${r(p.a1)},${r(p.w)}`
		case "circle":
			return `c${r(p.x)},${r(p.y)},${r(p.r)}`
		case "poly":
			return `p${p.rings.map(ring => ring.map(r).join(",")).join("|")}`
		case "text":
			return `t${r(p.x)},${r(p.y)},${r(p.h)},${r(p.rot)},${p.mirror},${p.font},${p.bold},${p.italic},${p.text}`
	}
}

// What a board object is: its kind, layer, net and exact shape (and drill holes). Ids and component
// indices are left out, they renumber between saves.
export function pcbObjectKey(o: PcbObject): string {
	return `${o.kind}|${o.layer}|${o.net ?? ""}|${o.prims.map(primKey).join(";")}|${o.holes.map(primKey).join(";")}`
}

export function diffPcb(a: PcbObject[], b: PcbObject[]): ObjectDiff {
	// Object ids are their index in scene.objects, so the index sets are id sets.
	return diffByKey(a, b, pcbObjectKey)
}

// A rendered schematic record group, reduced to what it looks like: its kind and its drawn markup
// without the record and owner indices (those renumber when anything earlier in the file changes).
export function schGroupKey(kind: string, markup: string): string {
	return `${kind}|${markup.replace(/\sdata-(?:i|o|ci)="[^"]*"/g, "")}`
}
