import { expect, test } from "vitest"
import { sheetConnectivity } from "./connectivity"
import type { SheetData, SheetObject } from "./schematic-data"

function sheet(objects: SheetObject[]): SheetData {
	return { objects, components: [], symbols: [] }
}

const wire = (i: number, ...pts: [number, number][]): SheetObject => ({ kind: "wire", i, points: pts.map(([x, y]) => ({ x, y })) })
const pin = (i: number, x: number, y: number, component = 900, designator = String(i)): SheetObject => ({ kind: "pin", i, component, designator, name: "", hot: { x, y } })

function sameNet(c: ReturnType<typeof sheetConnectivity>, a: number, b: number) {
	return c.netOf.get(a) !== undefined && c.netOf.get(a) === c.netOf.get(b)
}

test("a wire ending on the middle of another wire joins it (T-junction)", () => {
	const c = sheetConnectivity(sheet([wire(1, [0, 0], [100, 0]), wire(2, [50, 0], [50, 50])]))
	expect(sameNet(c, 1, 2)).toBe(true)
})

test("wires that merely cross do not connect", () => {
	const c = sheetConnectivity(sheet([wire(1, [0, 0], [100, 0]), wire(2, [50, -50], [50, 50])]))
	expect(sameNet(c, 1, 2)).toBe(false)
})

test("pins connect at their tip, at a wire vertex or along a wire, and directly to other pin tips", () => {
	const c = sheetConnectivity(
		sheet([wire(1, [0, 0], [100, 0]), pin(10, 0, 0), pin(11, 40, 0), pin(12, 200, 0), pin(13, 200, 0, 901), pin(14, 300, 0)]),
	)
	expect(sameNet(c, 1, 10)).toBe(true)
	expect(sameNet(c, 1, 11)).toBe(true)
	expect(sameNet(c, 12, 13)).toBe(true)
	expect(sameNet(c, 1, 12)).toBe(false)
	expect(c.netOf.get(14)).toBeDefined() // an unconnected pin is its own net
})

test("net labels name what they sit on, and equal labels on one sheet join", () => {
	const c = sheetConnectivity(
		sheet([
			wire(1, [0, 0], [100, 0]),
			wire(2, [0, 50], [100, 50]),
			{ kind: "label", i: 20, name: "SDA", at: { x: 30, y: 0 } },
			{ kind: "label", i: 21, name: "SDA", at: { x: 100, y: 50 } },
		]),
	)
	expect(sameNet(c, 1, 2)).toBe(true)
	expect(c.nets[c.netOf.get(1)!]!.labels).toEqual(["SDA"])
})

test("power ports and ports join by name on a sheet; a port connects at either end", () => {
	const c = sheetConnectivity(
		sheet([
			wire(1, [0, 0], [10, 0]),
			wire(2, [0, 50], [10, 50]),
			wire(3, [200, 0], [210, 0]),
			wire(4, [300, 0], [310, 0]),
			{ kind: "power", i: 30, name: "GND", at: { x: 0, y: 0 } },
			{ kind: "power", i: 31, name: "GND", at: { x: 0, y: 50 } },
			{ kind: "port", i: 40, name: "EN", ends: [{ x: 150, y: 0 }, { x: 200, y: 0 }], harness: false },
			{ kind: "port", i: 41, name: "EN", ends: [{ x: 250, y: 0 }, { x: 300, y: 0 }], harness: false },
		]),
	)
	expect(sameNet(c, 1, 2)).toBe(true)
	expect(sameNet(c, 3, 40)).toBe(true)
	expect(sameNet(c, 3, 4)).toBe(true)
	expect(c.nets[c.netOf.get(1)!]!.powers).toEqual(["GND"])
	expect(c.nets[c.netOf.get(3)!]!.ports).toEqual(["EN"])
})

test("sheet entries connect where a wire ends on them", () => {
	const c = sheetConnectivity(sheet([wire(1, [0, 0], [50, 0]), { kind: "entry", i: 50, symbol: 7, name: "VIN", at: { x: 50, y: 0 }, harness: false }]))
	expect(sameNet(c, 1, 50)).toBe(true)
	expect(c.nets[c.netOf.get(1)!]!.entries).toEqual([{ symbol: 7, name: "VIN" }])
})

test("harness: connector tip, harness wire and harness port form one bundle whose members are the entries' nets", () => {
	const c = sheetConnectivity(
		sheet([
			wire(1, [220, 220], [280, 220]),
			wire(2, [220, 210], [280, 210]),
			{ kind: "harnessConnector", i: 60, tip: { x: 170, y: 210 }, entries: [{ i: 61, name: "SDA", at: { x: 220, y: 220 } }, { i: 62, name: "SCL", at: { x: 220, y: 210 } }] },
			{ kind: "harnessWire", i: 63, points: [{ x: 130, y: 210 }, { x: 170, y: 210 }] },
			{ kind: "port", i: 64, name: "I2C", ends: [{ x: 80, y: 210 }, { x: 130, y: 210 }], harness: true },
		]),
	)
	expect(c.harnesses).toHaveLength(1)
	const h = c.harnesses[0]!
	expect(h.ports).toEqual(["I2C"])
	expect(h.members.get("SDA")).toBe(c.netOf.get(1))
	expect(h.members.get("SCL")).toBe(c.netOf.get(2))
	expect(c.netOf.get(64)).toBeUndefined() // a harness port is not an ordinary net member
})
