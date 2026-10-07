import { expect, test } from "vitest"
import { compileProject, type CompileInstance } from "./compile"
import type { SheetData, SheetObject } from "./schematic-data"

const P = (x: number, y: number) => ({ x, y })
const wire = (i: number, a: [number, number], b: [number, number]): SheetObject => ({ kind: "wire", i, points: [P(...a), P(...b)] })
const pin = (i: number, component: number, designator: string, at: [number, number]): SheetObject => ({ kind: "pin", i, component, designator, name: "", hot: P(...at) })
const comp = (i: number, designator: string) => ({ i, designator, comment: "", description: "", libReference: "", footprint: "", uniqueId: `U${i}`, parameters: [] })

// Top: sheet symbol U_CH = REPEAT(U_CH,1,2) with entry "IN" wired to R1.1 and labelled VIN; a GND power port on R1.2.
const top: SheetData = {
	objects: [
		wire(1, [0, 0], [100, 0]),
		{ kind: "label", i: 2, name: "VIN", at: P(50, 0) },
		pin(3, 50, "1", [0, 0]),
		{ kind: "entry", i: 4, symbol: 10, name: "IN", at: P(100, 0), harness: false },
		pin(5, 50, "2", [0, -100]),
		{ kind: "power", i: 6, name: "GND", at: P(0, -100) },
	],
	components: [comp(50, "R1")],
	symbols: [{ i: 10, designator: "REPEAT(U_CH,1,2)", fileName: "Ch.SchDoc", uniqueId: "SYM" }],
}
// Ch: port IN wired to C1.1; C1.2 on GND; an unnamed net between C1.3 and C1.4.
const ch: SheetData = {
	objects: [
		{ kind: "port", i: 1, name: "IN", ends: [P(0, 0), P(50, 0)], harness: false },
		wire(2, [50, 0], [100, 0]),
		pin(3, 60, "1", [100, 0]),
		pin(4, 60, "2", [0, -50]),
		{ kind: "power", i: 5, name: "GND", at: P(0, -50) },
		pin(6, 60, "3", [200, 0]),
		pin(7, 60, "4", [200, 0]),
	],
	components: [comp(60, "C1")],
	symbols: [],
}

const instances: CompileInstance[] = [
	{ id: "Top", docPath: "Top.SchDoc", parentId: null, designator: null, channel: null },
	{ id: "Top/U_CH1", docPath: "Ch.SchDoc", parentId: "Top", designator: "U_CH1", channel: { index: 1, name: "U_CH1" } },
	{ id: "Top/U_CH2", docPath: "Ch.SchDoc", parentId: "Top", designator: "U_CH2", channel: { index: 2, name: "U_CH2" } },
]
const sheets = new Map([
	["Top.SchDoc", top],
	["Ch.SchDoc", ch],
])

const compiled = () => compileProject({ instances, sheets, designatorFormat: "$Component_$ChannelIndex" })
const netAt = (p: ReturnType<typeof compiled>, inst: string, i: number) => p.nets[p.netAt[inst]![i]!]!

test("a sheet entry joins the child instance's port of the same name", () => {
	const p = compiled()
	expect(netAt(p, "Top", 1).id).toBe(netAt(p, "Top/U_CH1", 2).id)
})

test("power ports join across every instance", () => {
	const p = compiled()
	const gnd = netAt(p, "Top", 6)
	expect(netAt(p, "Top/U_CH1", 5).id).toBe(gnd.id)
	expect(netAt(p, "Top/U_CH2", 5).id).toBe(gnd.id)
	expect(gnd.netName).toBe("GND")
	expect(gnd.physicalName).toBe("GND")
	expect(gnd.occurrences.map(o => o.instanceId).sort()).toEqual(["Top", "Top/U_CH1", "Top/U_CH2"])
})

test("each channel gets its own copy of a net that lives inside it", () => {
	const p = compiled()
	const a = netAt(p, "Top/U_CH1", 6)
	const b = netAt(p, "Top/U_CH2", 6)
	expect(a.id).not.toBe(b.id)
	expect(a.netName).toBe("NetC1_1_3") // Altium: "Net" + physical designator + "_" + pin, e.g. NetR36_ESC_3_2
	expect(b.netName).toBe("NetC1_2_3")
})

test("the net name comes from the highest level; channel nets get the channel suffix as physical name", () => {
	const p = compiled()
	// VIN only exists on Top (no channel), so it is shared by both channels' IN ports.
	const vin = netAt(p, "Top", 1)
	expect(vin.netName).toBe("VIN")
	expect(vin.names).toEqual(expect.arrayContaining(["VIN", "IN"]))
	expect(netAt(p, "Top/U_CH2", 1).id).toBe(vin.id)
})

test("components get channel designators and remember their logical one", () => {
	const p = compiled()
	const c = p.components.find(c => c.instanceId === "Top/U_CH2")!
	expect(c.designator).toBe("C1_2")
	expect(c.logicalDesignator).toBe("C1")
	expect(p.components.find(c => c.instanceId === "Top")!.designator).toBe("R1")
})

test("harness members join across levels by entry name", () => {
	const parent: SheetData = {
		objects: [
			{ kind: "entry", i: 1, symbol: 9, name: "I2C", at: P(100, 0), harness: true },
			{ kind: "harnessWire", i: 2, points: [P(100, 0), P(150, 0)] },
			{ kind: "harnessConnector", i: 3, tip: P(150, 0), entries: [{ i: 4, name: "SDA", at: P(200, 10) }] },
			wire(5, [200, 10], [300, 10]),
			{ kind: "label", i: 6, name: "I2C_SDA", at: P(250, 10) },
		],
		components: [],
		symbols: [{ i: 9, designator: "U_KID", fileName: "Kid.SchDoc", uniqueId: "K" }],
	}
	const kid: SheetData = {
		objects: [
			{ kind: "port", i: 1, name: "I2C", ends: [P(0, 0), P(50, 0)], harness: true },
			{ kind: "harnessWire", i: 2, points: [P(50, 0), P(80, 0)] },
			{ kind: "harnessConnector", i: 3, tip: P(80, 0), entries: [{ i: 4, name: "SDA", at: P(130, 10) }] },
			wire(5, [130, 10], [200, 10]),
		],
		components: [],
		symbols: [],
	}
	const p = compileProject({
		instances: [
			{ id: "P", docPath: "P", parentId: null, designator: null, channel: null },
			{ id: "P/U_KID", docPath: "K", parentId: "P", designator: "U_KID", channel: null },
		],
		sheets: new Map([
			["P", parent],
			["K", kid],
		]),
		designatorFormat: "$Component_$ChannelIndex",
	})
	expect(p.nets[p.netAt["P/U_KID"]![5]!]!.netName).toBe("I2C_SDA")
})

test("components carry Altium's source path, which links pins to PCB pads even when designators repeat", () => {
	// PCB paths: channel index prefixed to the REPEAT symbol's unique id, then the component's.
	// Both channels' C1 are "C1" on this imaginary board; only the path tells their pads apart.
	const p = compileProject({
		instances,
		sheets,
		designatorFormat: "$Component_$ChannelIndex",
		padNets: new Map([
			["\\1SYM\\U60|3", "LOOP_A"],
			["\\2SYM\\U60|3", "LOOP_B"],
		]),
	})
	expect(p.components.find(c => c.instanceId === "Top/U_CH1")!.uniquePath).toBe("\\1SYM\\U60")
	expect(p.components.find(c => c.instanceId === "Top")!.uniquePath).toBe("\\U50")
	expect(p.components.find(c => c.instanceId === "Top/U_CH2")!.designator).toBe("C1_2") // designators stay formatted
	expect(p.nets[p.netAt["Top/U_CH1"]![6]!]!.physicalName).toBe("LOOP_A")
	expect(p.nets[p.netAt["Top/U_CH2"]![6]!]!.physicalName).toBe("LOOP_B")
})

test("a label on a harness wire names the harness; a BUNDLE.MEMBER label on a wire joins that member", () => {
	// Top: harness wire from the child's harness entry, labelled I2C_MAIN; a connector wire labelled I2C_MAIN.SDA.
	const parent: SheetData = {
		objects: [
			{ kind: "entry", i: 1, symbol: 9, name: "I2C", at: P(100, 0), harness: true },
			{ kind: "harnessWire", i: 2, points: [P(100, 0), P(200, 0)] },
			{ kind: "label", i: 3, name: "I2C_MAIN", at: P(150, 0) },
			wire(4, [0, 100], [100, 100]),
			{ kind: "label", i: 5, name: "I2C_MAIN.SDA", at: P(50, 100) },
		],
		components: [],
		symbols: [{ i: 9, designator: "U_MCU", fileName: "Mcu", uniqueId: "M" }],
	}
	const mcu: SheetData = {
		objects: [
			{ kind: "port", i: 1, name: "I2C", ends: [P(0, 0), P(50, 0)], harness: true },
			{ kind: "harnessWire", i: 2, points: [P(50, 0), P(80, 0)] },
			{ kind: "harnessConnector", i: 3, tip: P(80, 0), entries: [{ i: 4, name: "SDA", at: P(130, 10) }] },
			wire(5, [130, 10], [200, 10]),
		],
		components: [],
		symbols: [],
	}
	const p = compileProject({
		instances: [
			{ id: "T", docPath: "T", parentId: null, designator: null, channel: null },
			{ id: "T/U_MCU", docPath: "Mcu", parentId: "T", designator: "U_MCU", channel: null },
		],
		sheets: new Map([
			["T", parent],
			["Mcu", mcu],
		]),
		designatorFormat: "$Component_$ChannelIndex",
	})
	const sda = p.nets[p.netAt["T/U_MCU"]![5]!]!
	expect(sda.id).toBe(p.netAt["T"]![4])
	expect(sda.netName).toBe("I2C_MAIN.SDA")
	expect(p.nets.some(n => n.netName === "I2C_MAIN")).toBe(false) // the harness label is not a net
})

// Parent: a bus labelled PWM_WH[1..2] from the kid's entry PWM_3P[1..2]; its slices labelled PWM_WH1/2.
// Kid: port PWM_3P[1..2] on a bus; wires labelled PWM_3P1 / PWM_3P2.
test("buses join their slices across levels by position, and list them as one bundle", () => {
	const parent: SheetData = {
		objects: [
			{ kind: "entry", i: 1, symbol: 9, name: "PWM_3P[1..2]", at: P(100, 0), harness: false },
			{ kind: "bus", i: 2, points: [P(100, 0), P(200, 0)] },
			{ kind: "label", i: 3, name: "PWM_WH[1..2]", at: P(150, 0) },
			{ kind: "busEntry", i: 4, points: [P(180, 0), P(190, 10)] },
			wire(5, [190, 10], [300, 10]),
			{ kind: "label", i: 6, name: "PWM_WH1", at: P(250, 10) },
			wire(7, [190, 30], [300, 30]),
			{ kind: "label", i: 8, name: "PWM_WH2", at: P(250, 30) },
		],
		components: [],
		symbols: [{ i: 9, designator: "U_KID", fileName: "Kid.SchDoc", uniqueId: "K" }],
	}
	const kid: SheetData = {
		objects: [
			{ kind: "port", i: 1, name: "PWM_3P[1..2]", ends: [P(0, 0), P(50, 0)], harness: false },
			{ kind: "bus", i: 2, points: [P(50, 0), P(100, 0)] },
			wire(3, [0, 50], [100, 50]),
			{ kind: "label", i: 4, name: "PWM_3P1", at: P(50, 50) },
			wire(5, [0, 70], [100, 70]),
			{ kind: "label", i: 6, name: "PWM_3P2", at: P(50, 70) },
		],
		components: [],
		symbols: [],
	}
	const p = compileProject({
		instances: [
			{ id: "P", docPath: "P", parentId: null, designator: null, channel: null },
			{ id: "P/U_KID", docPath: "K", parentId: "P", designator: "U_KID", channel: null },
		],
		sheets: new Map([
			["P", parent],
			["K", kid],
		]),
		designatorFormat: "$Component_$ChannelIndex",
	})
	const at = (inst: string, i: number) => p.netAt[inst]![i]!
	expect(at("P/U_KID", 3)).toBe(at("P", 5))
	expect(at("P/U_KID", 5)).toBe(at("P", 7))
	expect(at("P/U_KID", 3)).not.toBe(at("P/U_KID", 5))
	expect(p.nets[at("P", 5)]!.netName).toBe("PWM_WH1") // the higher level names it
	// The range-named port and entry are the bus's, not nets of their own.
	expect(p.netAt["P/U_KID"]![1]).toBeUndefined()
	expect(p.netAt["P"]![1]).toBeUndefined()

	expect(p.bundles).toHaveLength(1)
	const bus = p.bundles[0]!
	expect(bus).toMatchObject({ kind: "bus", name: "PWM_WH[1..2]" })
	expect(bus.nets).toEqual([at("P", 5), at("P", 7)].sort((a, b) => a - b))
	for (const [inst, i] of [["P", 1], ["P", 2], ["P", 3], ["P", 4], ["P/U_KID", 1], ["P/U_KID", 2]] as const) expect(p.bundleAt[inst]![i]).toBe(0)
	expect(p.netBundles[at("P", 5)]).toEqual([0])
})

test("a harness is a bundle carrying its members, including BUNDLE.MEMBER labelled nets", () => {
	const sheet: SheetData = {
		objects: [
			{ kind: "harnessWire", i: 1, points: [P(0, 0), P(100, 0)] },
			{ kind: "label", i: 2, name: "I2C", at: P(50, 0) },
			{ kind: "harnessConnector", i: 3, tip: P(100, 0), entries: [{ i: 4, name: "SDA", at: P(150, 10) }] },
			wire(5, [150, 10], [250, 10]),
			wire(6, [0, 100], [100, 100]),
			{ kind: "label", i: 7, name: "I2C.SCL", at: P(50, 100) },
		],
		components: [],
		symbols: [],
	}
	const p = compileProject({
		instances: [{ id: "S", docPath: "S", parentId: null, designator: null, channel: null }],
		sheets: new Map([["S", sheet]]),
		designatorFormat: "$Component_$ChannelIndex",
	})
	expect(p.bundles).toHaveLength(1)
	expect(p.bundles[0]).toMatchObject({ kind: "harness", name: "I2C" })
	expect(p.bundles[0]!.nets).toEqual([p.netAt.S![5]!, p.netAt.S![6]!].sort((a, b) => a - b))
	expect(p.bundleAt.S![1]).toBe(0)
	expect(p.bundleAt.S![3]).toBe(0)
})
