// Things that moved together: of the items found in only one of two commits, those that are the same
// thing in both (same shape relative to their own position: key) at positions that differ by one
// offset. Each pair of look-alikes votes for its offset; the offset with most votes is taken first, its
// pairs matched one to one, split by place (one offset can move blocks in several places), and so on
// down while a block holds at least `min` items. Pure.

export interface Movable {
	key: string // what it is, relative to its own position (x, y)
	x: number
	y: number
	box: [number, number, number, number] // its extent, for splitting by place
}

// One block moved: B's items sit where A's are, plus (dx, dy). a, b: indices into the lists given.
export interface MoveGroup {
	dx: number
	dy: number
	a: number[]
	b: number[]
}

const PAIRS_PER_KEY = 20_000 // look-alike pairs voted per key at most (a board of identical vias)

export function findMoves(a: Movable[], b: Movable[], { min = 3, gap, step }: { min?: number; gap: number; step: number }): MoveGroup[] {
	const inB = new Map<string, number[]>()
	b.forEach((m, j) => {
		const list = inB.get(m.key)
		if (list) list.push(j)
		else inB.set(m.key, [j])
	})
	const byA = new Map<string, number[]>()
	a.forEach((m, i) => {
		if (!inB.has(m.key)) return
		const list = byA.get(m.key)
		if (list) list.push(i)
		else byA.set(m.key, [i])
	})
	// Votes: offset (rounded to step) -> the pairs that agree on it.
	const votes = new Map<string, { dx: number; dy: number; pairs: [number, number][] }>()
	for (const [key, as] of byA) {
		const bs = inB.get(key)!
		if (as.length * bs.length > PAIRS_PER_KEY) continue
		for (const i of as)
			for (const j of bs) {
				const dx = Math.round((b[j]!.x - a[i]!.x) / step) * step, dy = Math.round((b[j]!.y - a[i]!.y) / step) * step
				if (dx === 0 && dy === 0) continue
				const k = `${dx},${dy}`
				let v = votes.get(k)
				if (!v) votes.set(k, (v = { dx, dy, pairs: [] }))
				v.pairs.push([i, j])
			}
	}
	const usedA = new Set<number>(), usedB = new Set<number>()
	const out: MoveGroup[] = []
	for (const v of [...votes.values()].filter(v => v.pairs.length >= min).sort((x, y) => y.pairs.length - x.pairs.length)) {
		const pairs = v.pairs.filter(([i, j]) => {
			if (usedA.has(i) || usedB.has(j)) return false
			usedA.add(i)
			usedB.add(j)
			return true
		})
		// By place: pairs whose items (in A) are within gap of each other, and so on, are one block.
		const parent = pairs.map((_, k) => k)
		const root = (k: number): number => {
			while (parent[k] !== k) k = parent[k] = parent[parent[k]!]!
			return k
		}
		const order = pairs.map((_, k) => k).sort((p, q) => a[pairs[p]![0]]!.box[0] - a[pairs[q]![0]]!.box[0])
		for (let s = 0; s < order.length; s++) {
			const p = a[pairs[order[s]!]![0]]!.box
			for (let t = s + 1; t < order.length; t++) {
				const q = a[pairs[order[t]!]![0]]!.box
				if (q[0] > p[2] + gap) break
				if (q[1] <= p[3] + gap && q[3] >= p[1] - gap) parent[root(order[t]!)] = root(order[s]!)
			}
		}
		const blocks = new Map<number, [number, number][]>()
		pairs.forEach((pair, k) => {
			const r = root(k)
			const list = blocks.get(r)
			if (list) list.push(pair)
			else blocks.set(r, [pair])
		})
		for (const block of blocks.values()) {
			if (block.length >= min) out.push({ dx: v.dx, dy: v.dy, a: block.map(p => p[0]), b: block.map(p => p[1]) })
			else for (const [i, j] of block) usedA.delete(i), usedB.delete(j)
		}
	}
	return out.sort((x, y) => y.a.length - x.a.length)
}
