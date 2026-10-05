import { expect, test } from "vitest"
import type { PcbObject } from "../pcb/scene"
import { diffByKey, diffPcb, fileChanges, mostlyChanged, schGroupKey } from "./diff"

test("file changes from blob shas", () => {
	const a = new Map([["x", "1"], ["y", "2"], ["gone", "3"]])
	const b = new Map([["x", "1"], ["y", "9"], ["new", "4"]])
	expect([...fileChanges(a, b, ["x", "y", "gone", "new", "never"])]).toEqual([
		["y", "modified"],
		["gone", "removed"],
		["new", "added"],
	])
})

test("multiset diff: duplicates are matched one for one", () => {
	const d = diffByKey(["a", "a", "b", "c"], ["a", "b", "b", "d"], s => s)
	expect([...d.onlyA].sort()).toEqual([1, 3]) // the second "a", and "c"
	expect([...d.onlyB].sort()).toEqual([2, 3]) // the second "b", and "d"
	expect(d.total).toBe(8)
})

const track = (id: number, x: number, net = "GND", layer = "TOP"): PcbObject => ({
	id,
	kind: "track",
	layer,
	net,
	component: null,
	prims: [{ t: "seg", x1: x, y1: 0, x2: x + 100, y2: 0, w: 10 }],
	holes: [],
	bbox: [x, -5, x + 100, 5],
	at: [x, 0],
})

test("PCB: ids and float noise don't matter; moving, re-netting or re-layering does", () => {
	const a = [track(0, 0), track(1, 200), track(2, 400), track(3, 600)]
	const b = [track(7, 600.000001), track(8, 0), track(9, 250), track(10, 400, "VCC"), track(11, 800, "GND", "BOTTOM")]
	const d = diffPcb(a, b)
	expect([...d.onlyA].sort()).toEqual([1, 2]) // moved, re-netted
	expect([...d.onlyB].sort()).toEqual([2, 3, 4]) // moved, re-netted, new
})

test("most of it changed", () => {
	expect(mostlyChanged({ onlyA: new Set([0, 1]), onlyB: new Set([0, 1]), total: 6 })).toBe(true)
	expect(mostlyChanged({ onlyA: new Set([0]), onlyB: new Set(), total: 6 })).toBe(false)
})

test("SCH group key ignores record and owner indices, not the drawing", () => {
	const a = schGroupKey("27", '<polyline data-i="4" points="0,0 10,0"/>')
	expect(schGroupKey("27", '<polyline data-i="40" data-o="2" points="0,0 10,0"/>')).toBe(a)
	expect(schGroupKey("27", '<polyline points="0,0 10,5"/>')).not.toBe(a)
	expect(schGroupKey("25", '<polyline points="0,0 10,0"/>')).not.toBe(a)
})
