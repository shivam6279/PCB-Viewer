import { expect, test } from "vitest"
import { findMoves, type Movable } from "./moves"
import { schMovable } from "./sch-moves"

const item = (key: string, x: number, y: number): Movable => ({ key, x, y, box: [x, y, x + 5, y + 5] })

test("a block moved together is one move; a lone look-alike elsewhere is not", () => {
	const block = ["a", "b", "c", "d", "e"].map((k, i) => item(k, i * 10, 0))
	const moved = block.map(m => item(m.key, m.x + 30, m.y - 7))
	// "a" also turns up far away in B: a candidate at another offset, outvoted.
	const moves = findMoves(block, [...moved, item("a", 900, 900)], { gap: 50, step: 0.1 })
	expect(moves).toHaveLength(1)
	expect(moves[0]).toMatchObject({ dx: 30, dy: -7 })
	expect(moves[0]!.a.sort()).toEqual([0, 1, 2, 3, 4])
})

test("one offset in two places is two moves; fewer than min is none", () => {
	const left = ["a", "b", "c"].map((k, i) => item(k, i * 10, 0)), right = ["a", "b", "c"].map((k, i) => item(k, 1000 + i * 10, 0))
	const shift = (l: Movable[]) => l.map(m => item(m.key, m.x + 20, m.y))
	expect(findMoves([...left, ...right], [...shift(left), ...shift(right)], { gap: 50, step: 0.1 })).toHaveLength(2)
	expect(findMoves(left.slice(0, 2), shift(left).slice(0, 2), { gap: 50, step: 0.1 })).toEqual([])
})

test("a schematic record moved: the same key, its offset from the positions", () => {
	const at = (x: number, y: number) =>
		`<g data-k="25"><line x1="${x}" y1="${y}" x2="${x + 40}" y2="${y}" stroke-width="1"/><path d="M${x} ${y} L${x + 5} ${y + 5} l3 3"/><text x="${x}" y="${y - 2}" transform="rotate(90 ${x} ${y})" font-size="10">R12</text></g>`
	const a = schMovable(at(100, 200))!, b = schMovable(at(130, 250))!
	expect(a.key).toBe(b.key)
	expect([b.x - a.x, b.y - a.y]).toEqual([30, 50])
	// Another size is another thing.
	expect(schMovable(at(100, 200).replace('font-size="10"', 'font-size="12"'))!.key).not.toBe(a.key)
})
