import { expect, test } from "vitest"
import type { CompiledNet, CompiledProject } from "../model/compile"
import type { HierarchyNode } from "../model/hierarchy"
import type { SheetData } from "../model/schematic-data"
import { buildPortMenu, classifyClick, instanceLabel, jumpObjects } from "./interaction"

const node = (id: string, fileName: string, designator: string | null, channel: number | null, children: HierarchyNode[] = []): HierarchyNode => ({
	id,
	label: id,
	docPath: fileName,
	fileName,
	designator,
	displayDesignator: designator ?? fileName.replace(/.SchDoc$/, ""),
	channel,
	cyclic: false,
	children,
})
const mcu = (n: number) => node(`Top/U_ESC${n}/U_ESC_MCU${n}`, "ESC_MCU.SchDoc", `U_ESC_MCU${n}`, null)
const esc = (n: number) => node(`Top/U_ESC${n}`, "ESC.SchDoc", `U_ESC${n}`, n, [mcu(n)])
const power = node("Top/U_Power", "Power.SchDoc", "U_Power", null)
const top = node("Top", "Top.SchDoc", null, null, [power, esc(1), esc(2), esc(3)])

const sheet: SheetData = {
	objects: [
		{ kind: "wire", i: 1, points: [] },
		{ kind: "entry", i: 7, symbol: 6, name: "VIN", at: { x: 0, y: 0 }, harness: false },
	],
	components: [{ i: 3, designator: "R1", comment: "", description: "", libReference: "", footprint: "", uniqueId: "", parameters: [] }],
	symbols: [{ i: 6, designator: "REPEAT(U_ESC,1,3)", fileName: "ESC.SchDoc", uniqueId: "" }],
}
const net = (instances: string[]): CompiledNet => ({
	id: 0,
	netName: "N",
	physicalName: "N",
	names: [],
	pins: [],
	occurrences: instances.map(instanceId => ({ instanceId, objects: [1, 7] })),
})
const compiled: CompiledProject = { nets: [net(["Top"])], components: [], netAt: { Top: { 1: 0, 7: 0 } } }

test("clicks map to nets, components, the port menu and child sheets", () => {
	expect(classifyClick({ i: 1, k: "27", o: null }, top, sheet, compiled)).toEqual({ kind: "net", netId: 0 })
	expect(classifyClick({ i: 7, k: "16", o: 6 }, top, sheet, compiled)).toEqual({ kind: "port", netId: 0, i: 7 })
	expect(classifyClick({ i: 4, k: "4", o: 3 }, top, sheet, compiled)).toEqual({ kind: "component", id: "Top#3" })
	expect(classifyClick({ i: 9, k: "32", o: 6 }, top, sheet, compiled)).toEqual({ kind: "symbol", childId: "Top/U_ESC1", symbolI: 6 })
	expect(classifyClick({ i: 6, k: "15", o: null }, top, sheet, compiled)).toMatchObject({ kind: "symbol", symbolI: 6 })
	expect(classifyClick({ i: 9, k: "13", o: null }, top, sheet, compiled)).toBeNull()
})

test("the port menu groups REPEAT channels and opens the branch holding the current sheet", () => {
	const menu = buildPortMenu([top], net(["Top", "Top/U_ESC1", "Top/U_ESC1/U_ESC_MCU1", "Top/U_ESC2"]), "Top/U_ESC1")
	expect(menu).toHaveLength(1)
	const root = menu[0]!
	expect(root.label).toBe("Top.SchDoc(Top)")
	expect(root.expanded).toBe(true)
	const group = root.children[0]!
	expect(group.label).toBe("ESC.SchDoc(U_ESC1, U_ESC2)")
	expect(group.instanceId).toBeNull()
	expect(group.expanded).toBe(true)
	const [one, two] = group.children
	expect(one).toMatchObject({ label: "ESC.SchDoc(U_ESC1)", current: true, expanded: true, reached: true })
	expect(one!.children.map(c => c.label)).toEqual(["ESC_MCU.SchDoc(U_ESC_MCU1)"])
	expect(two).toMatchObject({ label: "ESC.SchDoc(U_ESC2)", current: false, expanded: false })
})

test("jumping frames the ports and sheet entries of the net, else all its objects", () => {
	expect(jumpObjects(net(["Top"]), "Top", sheet)).toEqual([7])
	expect(jumpObjects(net(["Top"]), "Top", { ...sheet, objects: [] })).toEqual([1, 7])
})

test("connectivity rows name instances without the extension", () => {
	expect(instanceLabel(mcu(1))).toBe("ESC_MCU(U_ESC_MCU1)")
	expect(instanceLabel(top)).toBe("Top(Top)")
})
