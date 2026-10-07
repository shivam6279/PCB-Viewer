import { describe, expect, it } from "vitest"
import { bomCsv, buildBom, parseBomDoc, type BomPart } from "./bom"

const DOC = [
	"|RECORD=BOM|VERSION=6|KIND=ALTIUM_DESIGNER_LIVEBOM",
	"|RECORD=Catalog|DBLINKFILEPATH=",
	"|RECORD=CatalogItem|ITEMTYPE=Automatic-NonVault|UNIQUEID=Lib.DbLib/Caps\\C0402X|DESIGNITEMID=C0402X|DESCRIPTION=CAP CER 0.1UF 16V|USERCOMMENTS=100n|LINENUMBER=",
	"|RECORD=PartChoice|PARTCHOICETYPE=AUTO_SCHLINKS|MANUFACTURER=KEMET|MANUFACTURERPARTNO=C0402X-T|SUPPLIER=Digi-Key|SUPPLIERPARTNO=399-1-ND",
	"|RECORD=PartChoiceGroups|GROUPBYFIELDCOUNT=0",
	"|RECORD=CatalogItem|ITEMTYPE=Automatic-NonVault|UNIQUEID=Lib.DbLib/Caps\\C0402X|DESIGNITEMID=C0402X|DESCRIPTION=CAP CER 2.2UF|USERCOMMENTS=2.2u|LINENUMBER=",
	"|RECORD=PartChoiceGroups|GROUPBYFIELDCOUNT=0",
	"|RECORD=CatalogItem|ITEMTYPE=Automatic-NonVault|UNIQUEID=IC.IntLib\\LED5050|DESIGNITEMID=LED5050|DESCRIPTION=RGB LED|USERCOMMENTS=APA102|LINENUMBER=",
	"|RECORD=PartChoiceGroups|GROUPBYFIELDCOUNT=0",
].join("\r\n")

const part = (designator: string, extra: Partial<BomPart> = {}): BomPart => ({
	unit: designator,
	designator,
	comment: "100n",
	description: "from the design",
	footprint: "0402",
	libraryItem: "Lib.DbLib/Caps\\C0402X",
	kind: 0,
	parameters: [],
	ref: { kind: "component", id: designator },
	...extra,
})

describe("parseBomDoc", () => {
	it("reads each catalog item with the part choices after it", () => {
		const items = parseBomDoc(DOC)
		expect(items.map(i => i.uniqueId)).toEqual(["Lib.DbLib/Caps\\C0402X", "Lib.DbLib/Caps\\C0402X", "IC.IntLib\\LED5050"])
		expect(items[0]!.choices).toEqual([{ manufacturer: "KEMET", mpn: "C0402X-T", supplier: "Digi-Key", supplierPartNo: "399-1-ND" }])
		expect(items[1]!.choices).toEqual([])
	})
})

describe("buildBom", () => {
	it("groups parts into lines with naturally sorted designators", () => {
		const bom = buildBom([part("C10"), part("C2"), part("R1", { comment: "10k", footprint: "0603", libraryItem: undefined })], "board", null)
		expect(bom.lines.map(l => [l.line, l.designators.map(d => d.name), l.quantity])).toEqual([
			[1, ["C2", "C10"], 2],
			[2, ["R1"], 1],
		])
		expect(bom.parts).toBe(3)
		expect(bom.lines[0]!.fromBomDoc).toBe(false)
	})

	it("takes description and part choices from the BOM document's matching item", () => {
		const bom = buildBom([part("C1"), part("C2", { comment: "2.2u" })], "board", { name: "P.BomDoc", items: parseBomDoc(DOC) })
		const [c1, c2] = bom.lines
		expect(c1).toMatchObject({ description: "CAP CER 0.1UF 16V", manufacturer: "KEMET", mpn: "C0402X-T", supplier: "Digi-Key", fromBomDoc: true })
		// Same library item, other comment: its own catalog entry.
		expect(c2).toMatchObject({ description: "CAP CER 2.2UF", manufacturer: "", fromBomDoc: true })
		expect(bom.bomDoc).toBe("P.BomDoc")
	})

	it("matches by item id alone when the library differs but the item is unambiguous", () => {
		const bom = buildBom([part("D1", { comment: "APA102", libraryItem: "IC.IntLib/Other\\LED5050" })], "schematic", { name: "x", items: parseBomDoc(DOC) })
		expect(bom.lines[0]).toMatchObject({ description: "RGB LED", fromBomDoc: true })
	})

	it("falls back to the part's own parameters for manufacturer and part numbers", () => {
		const parameters = [
			{ name: "Manufacturer", value: "Yageo" },
			{ name: "Manufacturer Part Number", value: "RC0402" },
		]
		const bom = buildBom([part("R1", { libraryItem: undefined, parameters })], "schematic", null)
		expect(bom.lines[0]).toMatchObject({ manufacturer: "Yageo", mpn: "RC0402" })
	})

	it("leaves out graphical and no-BOM parts, and counts a multi-part symbol once", () => {
		const bom = buildBom([part("U1"), part("U1"), part("LOGO1", { kind: 2 }), part("NT1", { kind: 4 }), part("X1", { kind: 5 }), part("")], "schematic", null)
		expect(bom.lines.flatMap(l => l.designators.map(d => d.name))).toEqual(["U1"])
	})

	it("counts two parts that share a designator (an unannotated copy) twice", () => {
		const bom = buildBom([part("C9", { unit: "a" }), part("C9", { unit: "b" })], "board", null)
		expect(bom.lines[0]).toMatchObject({ quantity: 2 })
		expect(bom.parts).toBe(2)
	})

	it("writes CSV with quoting", () => {
		const csv = bomCsv(buildBom([part("C1", { comment: 'say "hi", ok' }), part("C2", { comment: 'say "hi", ok' })], "board", null))
		expect(csv.split("\r\n")[1]).toBe('1,"C1, C2",2,"say ""hi"", ok",from the design,0402,,,,')
	})
})

describe("schematic and board parts", () => {
	it("reads a comment written as a parameter reference", async () => {
		const { schematicParts } = await import("./bom")
		const compiled = {
			nets: [],
			netAt: {},
			bundles: [],
			bundleAt: {},
			netBundles: {},
			components: [{ id: "a#1", instanceId: "a", i: 1, designator: "C8", logicalDesignator: "C8", comment: "=Value", description: "", libReference: "", footprint: "", uniqueId: "X", uniquePath: "\X", parameters: [{ name: "Value", value: "22nF" }] }],
		}
		expect(schematicParts(compiled)[0]!.comment).toBe("22nF")
	})
})
