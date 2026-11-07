import { expect, test } from "vitest"
import { chooseNetName, compileInstances, formatNetName, type NameCandidate, type NetNaming } from "./compile"
import type { HierarchyNode } from "./hierarchy"

const ALL: NetNaming = { ports: true, entries: true, higherLevelFirst: true, powerFirst: true, sheetNumbers: false }
const c = (name: string, kind: NameCandidate["kind"], depth: number, extra: Partial<NameCandidate> = {}): NameCandidate => ({
	name,
	kind,
	depth,
	instanceId: `S${depth}`,
	channel: null,
	docOrder: 0,
	...extra,
})
const pick = (cands: NameCandidate[], naming: Partial<NetNaming> = {}, format = "$Component_$ChannelIndex") =>
	chooseNetName(cands, { ...ALL, ...naming }, "hierarchical", format)?.name

test("power port names win when they take priority; otherwise a net label does", () => {
	const cands = [c("VCELL3", "label", 0), c("VBAT", "power", 0)]
	expect(pick(cands)).toBe("VBAT")
	expect(pick(cands, { powerFirst: false })).toBe("VCELL3")
})

test("among power ports the highest sheet's wins", () => {
	expect(pick([c("MOTOR_VBAT", "power", 1), c("VBAT", "power", 0)])).toBe("VBAT")
})

test("a net label on a lower sheet beats a port or sheet entry on a higher one", () => {
	expect(pick([c("DIN", "entry", 0), c("XBEE_DIN", "label", 1), c("DIN", "port", 1)])).toBe("XBEE_DIN")
})

test("higher-level names take priority, or else the first alphabetically", () => {
	const cands = [c("ESP_SDO", "label", 0), c("SDI", "label", 1)]
	expect(pick([c("SDI", "label", 0), c("ESP_SDO", "label", 1)])).toBe("SDI")
	expect(pick(cands, { higherLevelFirst: false })).toBe("ESP_SDO")
})

test("a name from outside any channel beats one inside a channel", () => {
	const inside = c("OUT1", "label", 2, { channel: { index: 1, name: "U_MOSFETs1" } })
	expect(pick([inside, c("OUT_U1", "label", 1)], { higherLevelFirst: false })).toBe("OUT_U1")
})

test("ports and sheet entries name nets only when allowed; entries only where ports may too", () => {
	expect(pick([c("BRAKE2", "entry", 0), c("BRAKE2", "port", 1)], { ports: false })).toBeUndefined()
	expect(pick([c("EN", "entry", 0)], { ports: true })).toBe("EN")
})

test("a harness named by a label on its wires names its members like a net label; one named by ports ranks as a port", () => {
	expect(pick([c("LED_CI", "label", 0), c("APA102.CI", "harness", 0, { bundleNamedBy: "label" })])).toBe("APA102.CI")
	expect(pick([c("SCL", "label", 0), c("I2C.SCL", "harness", 0, { bundleNamedBy: "port" })])).toBe("SCL")
})

test("channel net names: the designator format with the net's name, an _H/_L/_P/_N ending kept last when the channel is named", () => {
	expect(formatNetName("GHA", { index: 1, name: "U_MOSFETs1" }, "$Component_$ChannelIndex")).toBe("GHA_1")
	expect(formatNetName("RST_L", { index: 2, name: "U_ESC2" }, "$Component_$ChannelIndex")).toBe("RST_L_2")
	expect(formatNetName("BTN_R", { index: 1, name: "BTN1" }, "$Component_$RoomName")).toBe("BTN_R_BTN1")
	expect(formatNetName("CAN_H", { index: 0, name: "CAN0" }, "$Component_$RoomName")).toBe("CAN_CAN0_H")
	expect(formatNetName("FLT_L", { index: 1, name: "MTR1" }, "$Component_$ChannelPrefix")).toBe("FLT_MTR1_L")
	expect(formatNetName("VIN", null, "$Component_$ChannelIndex")).toBe("VIN")
})

test("a sheet placed by several sheet symbols gets a channel per symbol, in the natural order of their designators", () => {
	const node = (id: string, docPath: string, designator: string | null, children: HierarchyNode[] = []): HierarchyNode => ({
		id,
		label: id,
		docPath,
		fileName: docPath,
		designator,
		displayDesignator: designator ?? docPath,
		channel: null,
		cyclic: false,
		children,
	})
	const top = node("Top", "Top.SchDoc", null, [
		node("Top/MW_48V", "Out.SchDoc", "MW_48V"),
		node("Top/MW_120V", "Out.SchDoc", "MW_120V"),
		node("Top/MW_12V", "Out.SchDoc", "MW_12V"),
		node("Top/U_MCU", "Mcu.SchDoc", "U_MCU"),
	])
	const channels = Object.fromEntries(compileInstances([top]).map(i => [i.id, i.channel?.index ?? null]))
	expect(channels).toEqual({ Top: null, "Top/MW_48V": 2, "Top/MW_120V": 3, "Top/MW_12V": 1, "Top/U_MCU": null })
})
