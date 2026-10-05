import { expect, test } from "vitest"
import { buildHierarchy, channelOf, flattenHierarchy, parseRepeat } from "./hierarchy"
import type { SheetLink } from "../parse/altium"

function build(sheets: string[], links: Record<string, SheetLink[]>) {
	const byName = new Map(sheets.map(s => [s.toLowerCase(), s]))
	return buildHierarchy({
		sheets,
		linksBySheet: new Map(Object.entries(links)),
		resolve: fileName => byName.get(fileName.toLowerCase()) ?? null,
	})
}

test("parseRepeat", () => {
	expect(parseRepeat("REPEAT(U_ESC,1,3)")).toEqual({ name: "U_ESC", first: 1, last: 3 })
	expect(parseRepeat(" repeat( CH , 2 , 4 ) ")).toEqual({ name: "CH", first: 2, last: 4 })
	expect(parseRepeat("U_Power")).toBeNull()
	expect(parseRepeat("REPEAT(X,3,1)")).toBeNull()
})

test("roots are the sheets nobody references; children carry designators", () => {
	const tree = build(["Top.SchDoc", "Power.SchDoc", "Loose.SchDoc"], {
		"Top.SchDoc": [{ fileName: "power.schdoc", designator: "U_Power" }],
		"Power.SchDoc": [],
		"Loose.SchDoc": [],
	})
	expect(tree.map(n => n.label)).toEqual(["Top.SchDoc (Top)", "Loose.SchDoc (Loose)"])
	const power = tree[0]!.children[0]!
	expect(power).toMatchObject({ label: "Power.SchDoc (U_Power)", docPath: "Power.SchDoc", designator: "U_Power", channel: null })
})

test("REPEAT expands to one node per channel", () => {
	const tree = build(["Top.SchDoc", "ESC.SchDoc"], {
		"Top.SchDoc": [{ fileName: "ESC.SchDoc", designator: "REPEAT(U_ESC,1,3)" }],
		"ESC.SchDoc": [],
	})
	expect(tree[0]!.children.map(c => [c.label, c.channel])).toEqual([
		["ESC.SchDoc (U_ESC1)", 1],
		["ESC.SchDoc (U_ESC2)", 2],
		["ESC.SchDoc (U_ESC3)", 3],
	])
})

test("sheets below a REPEAT channel are numbered with it", () => {
	const tree = build(["Top.SchDoc", "ESC.SchDoc", "MCU.SchDoc"], {
		"Top.SchDoc": [{ fileName: "ESC.SchDoc", designator: "REPEAT(U_ESC,1,2)" }],
		"ESC.SchDoc": [{ fileName: "MCU.SchDoc", designator: "U_MCU" }],
		"MCU.SchDoc": [],
	})
	expect(tree[0]!.children.map(c => c.children[0]!.label)).toEqual(["MCU.SchDoc (U_MCU1)", "MCU.SchDoc (U_MCU2)"])
	expect(tree[0]!.children[1]!.children[0]!).toMatchObject({ designator: "U_MCU", displayDesignator: "U_MCU2" })
})

test("missing child file yields a node with docPath null", () => {
	const tree = build(["Top.SchDoc"], { "Top.SchDoc": [{ fileName: "Gone.SchDoc", designator: "U_Gone" }] })
	expect(tree[0]!.children[0]).toMatchObject({ label: "Gone.SchDoc (U_Gone)", docPath: null, children: [] })
})

test("cycles terminate and are marked", () => {
	const tree = build(["A.SchDoc", "B.SchDoc"], {
		"A.SchDoc": [{ fileName: "B.SchDoc", designator: "U_B" }],
		"B.SchDoc": [{ fileName: "A.SchDoc", designator: "U_A" }],
	})
	// Everything is referenced, so the first sheet becomes the root.
	expect(tree.map(n => n.label)).toEqual(["A.SchDoc (A)"])
	const back = tree[0]!.children[0]!.children[0]!
	expect(back).toMatchObject({ docPath: "A.SchDoc", cyclic: true, children: [] })
})

test("the same child placed twice gets two distinct ids", () => {
	const tree = build(["Top.SchDoc", "Act.SchDoc"], {
		"Top.SchDoc": [
			{ fileName: "Act.SchDoc", designator: "ACT" },
			{ fileName: "Act.SchDoc", designator: "ACT" },
		],
		"Act.SchDoc": [],
	})
	const ids = flattenHierarchy(tree).map(n => n.id)
	expect(new Set(ids).size).toBe(ids.length)
	expect(ids).toHaveLength(3)
})

test("channelOf finds the nearest REPEAT channel at or above a node", () => {
	const tree = build(["Top.SchDoc", "ESC.SchDoc", "ESC_MCU.SchDoc"], {
		"Top.SchDoc": [{ fileName: "ESC.SchDoc", designator: "REPEAT(U_ESC,1,3)" }],
		"ESC.SchDoc": [{ fileName: "ESC_MCU.SchDoc", designator: "U_ESC_MCU" }],
		"ESC_MCU.SchDoc": [],
	})
	const ids = flattenHierarchy(tree).map(n => n.id)
	expect(channelOf(tree, "Top.SchDoc")).toBeNull()
	expect(channelOf(tree, "Top.SchDoc/U_ESC2")).toEqual({ index: 2, name: "U_ESC2" })
	expect(channelOf(tree, "Top.SchDoc/U_ESC2/U_ESC_MCU")).toEqual({ index: 2, name: "U_ESC2" })
	expect(ids).toContain("Top.SchDoc/U_ESC2/U_ESC_MCU")
})
