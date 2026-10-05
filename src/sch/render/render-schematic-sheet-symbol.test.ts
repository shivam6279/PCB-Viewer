import { expect, test } from "vitest"
import { parseAltiumSchDoc } from "altiumts"
import { serializeAltiumSheetToSvg } from "./serialize-altium-sheet-to-svg"

// Expected geometry and colours for Cubli Top.SchDoc (ESC sheet symbol).
function render(designator: string, entries: string[]) {
	const doc = parseAltiumSchDoc(
		[
			"|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=9",
			"|RECORD=31|FONTIDCOUNT=2|SIZE1=10|FONTNAME1=Times New Roman|SIZE2=10|FONTNAME2=Consolas|SYSTEMFONT=1|SHEETSTYLE=6",
			"|RECORD=15|INDEXINSHEET=0|LOCATION.X=640|LOCATION.Y=790|XSIZE=140|YSIZE=40|COLOR=128|AREACOLOR=13223074|ISSOLID=T",
			`|RECORD=32|OWNERINDEX=1|LOCATION.X=640|LOCATION.Y=800|COLOR=8388608|FONTID=2|TEXT=${designator}`,
			"|RECORD=33|OWNERINDEX=1|LOCATION.X=640|LOCATION.Y=790|COLOR=8388608|FONTID=2|TEXT=ESC.SchDoc",
			...entries.map(e => `|RECORD=16|OWNERINDEX=1|COLOR=128|AREACOLOR=8454143|TEXTCOLOR=128|TEXTFONTID=2|ARROWKIND=Block & Triangle${e}`),
		].join("\r\n"),
	)
	return serializeAltiumSheetToSvg(doc, { margin: 0 }) // SVG x = Altium x, SVG y = 950 - Altium y
}

const symbolRects = (svg: string) => [...svg.matchAll(/<rect data-record="15"[^>]*>/g)].map(m => m[0])

test("a sheet symbol is filled with its own area colour and outlined in its border colour", () => {
	const [rect] = symbolRects(render("U_Power", []))
	expect(rect).toContain('fill="#a2c4c9"') // AREACOLOR 13223074 is BGR
	expect(rect).toContain('stroke="#800000"')
	expect(rect).toContain('x="640" y="160" width="140" height="40"')
})

test("a REPEAT sheet symbol is drawn as a stack of three, offset by 2 units, base on top", () => {
	const rects = symbolRects(render("REPEAT(U_ESC,1,3)", []))
	expect(rects).toHaveLength(3)
	expect(rects[0]).toContain('x="644" y="164"')
	expect(rects[1]).toContain('x="642" y="162"')
	expect(rects[2]).toContain('x="640" y="160"')
})

const entryPolygon = (svg: string) => /<g data-record="16"><polygon points="([^"]+)" fill="([^"]+)" stroke="([^"]+)"/.exec(svg)

test.each([
	["input on the left: block then a tip pointing into the sheet", "|NAME=VIN_ESC|DISTANCEFROMTOP=1|IOTYPE=2", "640,166 650.9,166 655,170 650.9,174 640,174"],
	["output on the left: tip at the sheet edge", "|NAME=OUT|DISTANCEFROMTOP=1|IOTYPE=1", "640,170 644.1,166 655,166 655,174 644.1,174"],
	["bidirectional on the right: tips at both ends", "|NAME=CAN_H|SIDE=1|DISTANCEFROMTOP=1|IOTYPE=3", "780,170 776,166 769,166 765,170 769,174 776,174"],
	["unspecified: a plain block", "|NAME=X|DISTANCEFROMTOP=1", "640,166 655,166 655,174 640,174"],
])("sheet entry %s", (_label, fields, points) => {
	const m = entryPolygon(render("U_ESC", [fields]))
	expect(m?.[1]).toBe(points)
	expect(m?.[2]).toBe("#ffff80") // AREACOLOR 8454143
	expect(m?.[3]).toBe("#800000")
})

test("entry names sit 20 units in from the sheet edge, in the entry's text colour", () => {
	const left = render("U_ESC", ["|NAME=VIN_ESC|DISTANCEFROMTOP=1|IOTYPE=2"])
	expect(left).toMatch(/<text x="660" y="170" text-anchor="start"[^>]*fill="#800000"[^>]*>VIN_ESC<\/text>/)
	const right = render("U_ESC", ["|NAME=CAN_H|SIDE=1|DISTANCEFROMTOP=1|IOTYPE=3"])
	expect(right).toMatch(/<text x="760" y="170" text-anchor="end"[^>]*>CAN_H<\/text>/)
})
