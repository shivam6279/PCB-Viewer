// Comparing two boards by what a fab would make of them, not by how the file stores it: each layer's
// artwork (copper with its drills cut out, mask openings, silk, paste, mechanical, drills, the board's
// shape) in one commit but not the other, gathered into the places that changed. A part moved, added
// or removed is one change (its outline), not every pad, opening and line it brings; a block of parts,
// tracks and vias moved together is one change too (see moves.ts).
import { artworkDifference, type ArtworkPiece } from "../3d/board-geometry"
import { ARTWORK_CELL } from "./artwork-keys"
import type { PcbObject, PcbScene, PcbSceneComponent, Prim } from "../pcb/scene"
import { diffByKey, diffPcb, pcbObjectKey } from "./diff"
import { findMoves, type Movable } from "./moves"

// A part placed differently, or in only one commit: its outline (four corners, x,y each) in each.
export interface PartChange {
	designator: string
	kind: "moved" | "added" | "removed" // added: only in A; removed: only in B
	a: number[] | null
	b: number[] | null
	sideA: "top" | "bottom" | null // the side it is on in each
	sideB: "top" | "bottom" | null
}

// A block moved: B's members sit where A's are, plus (dx, dy). Its extent in each, the parts in it, how
// many things it holds, and the layers they are on.
export interface BlockMove {
	dx: number
	dy: number
	a: [number, number, number, number]
	b: [number, number, number, number]
	parts: string[]
	count: number
	layers: string[]
}

// One place that changed: the pieces and parts near each other, their extent, and what it is.
export interface ChangeArea {
	box: [number, number, number, number]
	layers: string[]
	a: number // pieces in A only
	b: number // pieces in B only
	parts: number[] // indices into ArtworkDiff.parts
	what: string // the kinds of object that changed there and their nets: "Tracks, Vias · MODE, GND"
	layer?: LayerChange // a change to the layer stack (the area is the whole board)
	move?: number // a block moved: its index in ArtworkDiff.moves (the area spans where it was and is)
}

// A copper layer in only one board (added: only in A), or the same layer under another name.
export interface LayerChange {
	kind: "added" | "removed" | "renamed"
	name: string // A's name (B's for removed)
	was?: string // renamed: B's name
}

export interface ArtworkDiff {
	pieces: ArtworkPiece[]
	parts: PartChange[]
	moves: BlockMove[]
	areas: ChangeArea[]
}

const LOOSE_BLOCK = 8 // things in a block of tracks and vias alone (no part), at least
const GAP = 25 // mils: pieces this close may be one change (a rerouted track: its copper and the pour round it)
const MAX_SPAN = ARTWORK_CELL // mils: an area grows no wider or taller than this by gathering pieces

const isText = (o: PcbObject) => o.prims.some(p => p.t === "text")
const drawn = (o: PcbObject) => o.kind !== "body" && o.layer !== "KEEPOUT"

// Parts by their link to the schematic (else their designator).
const partKey = (c: PcbSceneComponent) => c.sourceUniqueId || c.designator
const placed = (c: PcbSceneComponent) => `${c.x.toFixed(2)},${c.y.toFixed(2)},${c.rotation},${c.side}`

// An object relative to a point: its prims and holes shifted by (-x, -y).
function shiftPrim(p: Prim, x: number, y: number): Prim {
	switch (p.t) {
		case "seg":
			return { ...p, x1: p.x1 - x, y1: p.y1 - y, x2: p.x2 - x, y2: p.y2 - y }
		case "poly":
			return { ...p, rings: p.rings.map(r => r.map((v, i) => v - (i % 2 ? y : x))) }
		default:
			return { ...p, x: p.x - x, y: p.y - y }
	}
}

const union = (boxes: number[][]): [number, number, number, number] => [Math.min(...boxes.map(b => b[0]!)), Math.min(...boxes.map(b => b[1]!)), Math.max(...boxes.map(b => b[2]!)), Math.max(...boxes.map(b => b[3]!))]

const boxOf = (corners: number[]): [number, number, number, number] => {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
	for (let i = 0; i + 1 < corners.length; i += 2) (x0 = Math.min(x0, corners[i]!)), (x1 = Math.max(x1, corners[i]!)), (y0 = Math.min(y0, corners[i + 1]!)), (y1 = Math.max(y1, corners[i + 1]!))
	return [x0, y0, x1, y1]
}

export function diffArtwork(a: PcbScene, b: PcbScene): ArtworkDiff {
	const { copper, layerChanges } = pairCopper(a, b)
	// Parts moved, added or removed: marked whole, their own objects left out of the artwork compared.
	// A part only shifted (same turn and side) may have moved with a block: looked at with the rest.
	const parts: PartChange[] = []
	const shifted: { ca: PcbSceneComponent; cb: PcbSceneComponent }[] = []
	const skipA = new Set<number>(), skipB = new Set<number>()
	const inB = new Map(b.components.map((c, i) => [partKey(c), i]))
	const matched = new Set<number>()
	a.components.forEach(ca => {
		const j = inB.get(partKey(ca))
		const cb = j === undefined ? undefined : b.components[j]!
		if (j !== undefined) matched.add(j)
		if (cb && placed(ca) === placed(cb)) return
		if (cb && ca.rotation === cb.rotation && ca.side === cb.side) shifted.push({ ca, cb })
		else parts.push({ designator: ca.designator, kind: cb ? "moved" : "added", a: ca.box, b: cb?.box ?? null, sideA: ca.side, sideB: cb?.side ?? null })
		for (const id of ca.objects) skipA.add(id)
		if (cb) for (const id of cb.objects) skipB.add(id)
	})
	b.components.forEach((cb, j) => {
		if (matched.has(j)) return
		parts.push({ designator: cb.designator, kind: "removed", a: null, b: cb.box, sideA: null, sideB: cb.side })
		for (const id of cb.objects) skipB.add(id)
	})
	const without = (s: PcbScene, skip: Set<number>): PcbScene => (skip.size ? { ...s, objects: s.objects.filter(o => !skip.has(o.id)) } : s)
	let restA = without(a, skipA), restB = without(b, skipB)

	// Artwork can differ only where an object differs: the objects in only one commit say where to look.
	const d = diffPcb(restA.objects, restB.objects)
	let changedA = [...d.onlyA].map(i => restA.objects[i]!).filter(drawn)
	let changedB = [...d.onlyB].map(i => restB.objects[i]!).filter(drawn)

	// Blocks moved together, layer by layer: loose objects (not a part's) in one commit only, as what they
	// are relative to where they are (B's copper layers under A's keys), and the shifted parts, each on its
	// side's copper layer. Vias, through every layer, are a layer of their own (Multi-Layer).
	const toA = new Map([...copper].map(([ka, kb]) => [kb, ka]))
	type Entry = { m: Movable; obj?: PcbObject; part?: number }
	const byLayer = new Map<string, { a: Entry[]; b: Entry[] }>()
	const put = (layer: string, side: "a" | "b", e: Entry) => {
		let at = byLayer.get(layer)
		if (!at) byLayer.set(layer, (at = { a: [], b: [] }))
		at[side].push(e)
	}
	const looseIn = (list: PcbObject[], side: "a" | "b", rename?: Map<string, string>) => {
		for (const o of list) {
			if (o.component !== null) continue
			const layer = o.span ? "MULTILAYER" : (rename?.get(o.layer) ?? o.layer)
			const [x, y] = [o.bbox[0], o.bbox[1]]
			const key = pcbObjectKey({ ...o, layer, prims: o.prims.map(p => shiftPrim(p, x, y)), holes: o.holes.map(p => shiftPrim(p, x, y)) })
			put(layer, side, { m: { key, x, y, box: o.bbox }, obj: o })
		}
	}
	looseIn(changedA, "a")
	looseIn(changedB, "b", toA)
	const partMovable = (c: PcbSceneComponent): Movable => ({ key: `part|${c.footprint}|${c.designator}`, x: c.x, y: c.y, box: boxOf(c.box) })
	shifted.forEach(({ ca, cb }, k) => {
		const layer = ca.side === "top" ? "TOP" : "BOTTOM"
		put(layer, "a", { m: partMovable(ca), part: k })
		put(layer, "b", { m: partMovable(cb), part: k })
	})
	const movedA = new Set<PcbObject>(), movedB = new Set<PcbObject>(), movedParts = new Set<number>()
	const moves: BlockMove[] = []
	for (const [layer, { a: ea, b: eb }] of byLayer)
		for (const g of findMoves(
			ea.map(e => e.m),
			eb.map(e => e.m),
			{ min: 3, gap: 50, step: 0.1 },
		)) {
			// A few loose tracks or vias matching at some far offset is chance (a regular grid of vias lines
			// up with itself): a block with no part in it must be bigger.
			if (!g.a.some(i => ea[i]!.part !== undefined) && g.a.length < LOOSE_BLOCK) continue
			const boxesA: number[][] = [], boxesB: number[][] = [], names: string[] = []
			for (const i of g.a) {
				const e = ea[i]!
				if (e.obj) movedA.add(e.obj)
				if (e.part !== undefined) {
					movedParts.add(e.part)
					names.push(shifted[e.part]!.ca.designator)
				}
				boxesA.push(e.m.box)
			}
			for (const j of g.b) {
				const e = eb[j]!
				if (e.obj) movedB.add(e.obj)
				boxesB.push(e.m.box)
			}
			moves.push({ dx: g.dx, dy: g.dy, a: union(boxesA), b: union(boxesB), parts: names, count: g.a.length, layers: [layer] })
		}
	moves.sort((x, y) => y.count - x.count)
	shifted.forEach(({ ca, cb }, k) => {
		if (!movedParts.has(k)) parts.push({ designator: ca.designator, kind: "moved", a: ca.box, b: cb.box, sideA: ca.side, sideB: cb.side })
	})
	if (movedA.size || movedB.size) {
		restA = { ...restA, objects: restA.objects.filter(o => !movedA.has(o)) }
		restB = { ...restB, objects: restB.objects.filter(o => !movedB.has(o)) }
		changedA = changedA.filter(o => !movedA.has(o))
		changedB = changedB.filter(o => !movedB.has(o))
	}
	const pieces = artworkDifference(restA, restB, changedA, changedB, copper)
	// TrueType text has no outline here: a text in only one commit is its box.
	for (const [list, side] of [[changedA, "a"], [changedB, "b"]] as const)
		for (const o of list) if (isText(o)) pieces.push({ layer: o.layer, side, rings: [[o.bbox[0], o.bbox[1], o.bbox[2], o.bbox[1], o.bbox[2], o.bbox[3], o.bbox[0], o.bbox[3]]], box: [...o.bbox] })

	// What is gathered: each piece (a big one by each grid cell it reaches) and each part.
	const items: { box: [number, number, number, number]; piece?: number; part?: number }[] = []
	pieces.forEach((p, i) => {
		for (const box of p.cells ?? [p.box]) items.push({ box, piece: i })
	})
	parts.forEach((p, k) => {
		const ba = p.a ? boxOf(p.a) : null, bb = p.b ? boxOf(p.b) : null
		// A moved part: one place spanning where it was and where it is.
		const box: [number, number, number, number] = ba && bb ? [Math.min(ba[0], bb[0]), Math.min(ba[1], bb[1]), Math.max(ba[2], bb[2]), Math.max(ba[3], bb[3])] : (ba ?? bb)!
		items.push({ box, part: k })
	})
	const { groups, of } = gather(items)
	const areas: ChangeArea[] = groups.map(box => ({ box, layers: [], a: 0, b: 0, parts: [], what: "" }))
	const layerAreas: ChangeArea[] = layerChanges.map(layer => ({ box: [...a.bounds], layers: [], a: 0, b: 0, parts: [], what: "", layer }))
	const moveAreas: ChangeArea[] = moves.map((m, i) => ({ box: union([m.a, m.b]), layers: m.layers, a: 0, b: 0, parts: [], what: "", move: i }))
	items.forEach((it, n) => {
		const c = areas[of[n]!]!
		if (it.part !== undefined) return void c.parts.push(it.part)
		const p = pieces[it.piece!]!
		if (!c.layers.includes(p.layer)) c.layers.push(p.layer)
		c[p.side]++
	})
	// What changed in each: the kinds of object and their nets.
	for (const c of areas) {
		// A pour spans most of the board: it is named only where nothing else changed.
		const touching = [...changedA, ...changedB].filter(o => o.bbox[0] <= c.box[2] && o.bbox[2] >= c.box[0] && o.bbox[1] <= c.box[3] && o.bbox[3] >= c.box[1])
		const solid = touching.filter(o => !o.pour)
		const near = solid.length ? solid : touching
		const kinds = [...new Set(near.map(o => (o.pour ? "pour" : o.kind === "region" || o.kind === "fill" ? "copper" : o.kind)))]
		const nets = [...new Set(near.map(o => o.net).filter((n): n is string => !!n))]
		const what = kinds.length ? `${kinds.map(k => `${k[0]!.toUpperCase()}${k.slice(1)}${k === "copper" ? "" : "s"}`).join(", ")}${nets.length ? ` · ${nets.slice(0, 3).join(", ")}${nets.length > 3 ? ` +${nets.length - 3}` : ""}` : ""}` : ""
		c.what = what
	}
	// In reading order: top of the board first, then left to right.
	const order = areas.map((_, i) => i).sort((i, j) => areas[j]!.box[3] - areas[i]!.box[3] || areas[i]!.box[0] - areas[j]!.box[0])
	return { pieces, parts, moves, areas: [...layerAreas, ...moveAreas, ...order.map(i => areas[i]!)] }
}

// The copper layers both boards have, A's key to B's: by name (a stack rearranged renumbers its
// layers); else by key, when it is the same layer renamed (most of what is on it is the same: a key
// reused for another layer is that layer removed and another added); and what changed in the stack:
// L3 - PWR removed.
export function pairCopper(a: PcbScene, b: PcbScene): { copper: Map<string, string>; layerChanges: LayerChange[] } {
	const la = a.layers.filter(l => l.group === "copper"), lb = b.layers.filter(l => l.group === "copper")
	const copper = new Map<string, string>()
	const taken = new Set<string>()
	for (const l of la) {
		const m = lb.find(x => x.name === l.name && !taken.has(x.key))
		if (m) copper.set(l.key, m.key), taken.add(m.key)
	}
	const changes: LayerChange[] = []
	for (const l of la) {
		if (copper.has(l.key)) continue
		const m = lb.find(x => x.key === l.key && !taken.has(x.key))
		if (m && sameLayer(a, l.key, b, m.key)) {
			copper.set(l.key, m.key)
			taken.add(m.key)
			changes.push({ kind: "renamed", name: l.name, was: m.name })
		} else changes.push({ kind: "added", name: l.name })
	}
	for (const l of lb) if (!taken.has(l.key)) changes.push({ kind: "removed", name: l.name })
	return { copper, layerChanges: changes }
}

function sameLayer(a: PcbScene, ka: string, b: PcbScene, kb: string): boolean {
	const on = (s: PcbScene, k: string) => s.objects.filter(o => o.layer === k && !o.pour).map(o => pcbObjectKey({ ...o, layer: "" }))
	const oa = on(a, ka), ob = on(b, kb)
	if (!oa.length && !ob.length) return true
	const d = diffByKey(oa, ob, k => k)
	return oa.length - d.onlyA.size >= Math.max(oa.length, ob.length) / 2
}

// Gathers boxes into places: the nearest first (within GAP), as long as the place stays within
// MAX_SPAN each way, so changes all over a board never chain into one. Returns each place's extent and
// each box's place.
export function gather(items: { box: [number, number, number, number] }[]): { groups: [number, number, number, number][]; of: number[] } {
	const parent = items.map((_, i) => i)
	const box = items.map(it => [...it.box] as [number, number, number, number])
	const root = (i: number): number => {
		while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!
		return i
	}
	const gapOf = (p: number[], q: number[]) => Math.max(q[0]! - p[2]!, p[0]! - q[2]!, q[1]! - p[3]!, p[1]! - q[3]!, 0)
	// Candidate pairs, by a sweep over the left edges.
	const order = items.map((_, i) => i).sort((i, j) => items[i]!.box[0] - items[j]!.box[0])
	const pairs: [number, number, number][] = []
	for (let k = 0; k < order.length; k++) {
		const p = items[order[k]!]!.box
		for (let m = k + 1; m < order.length; m++) {
			const q = items[order[m]!]!.box
			if (q[0] > p[2] + GAP) break
			const g = gapOf(p, q)
			if (g <= GAP) pairs.push([g, order[k]!, order[m]!])
		}
	}
	pairs.sort((x, y) => x[0] - y[0])
	for (const [, i, j] of pairs) {
		const ri = root(i), rj = root(j)
		if (ri === rj) continue
		const bi = box[ri]!, bj = box[rj]!
		const merged: [number, number, number, number] = [Math.min(bi[0], bj[0]), Math.min(bi[1], bj[1]), Math.max(bi[2], bj[2]), Math.max(bi[3], bj[3])]
		if (merged[2] - merged[0] > MAX_SPAN || merged[3] - merged[1] > MAX_SPAN) continue
		parent[rj] = ri
		box[ri] = merged
	}
	const index = new Map<number, number>()
	const groups: [number, number, number, number][] = []
	const of = items.map((_, i) => {
		const r = root(i)
		let at = index.get(r)
		if (at === undefined) {
			index.set(r, (at = groups.length))
			groups.push(box[r]!)
		}
		return at
	})
	return { groups, of }
}
