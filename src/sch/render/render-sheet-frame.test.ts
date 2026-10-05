import { expect, test } from "vitest"
import { parseAltiumSchDoc } from "altiumts"
import { serializeAltiumSheetToSvg } from "./serialize-altium-sheet-to-svg"

const HEADER = "|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=3"
const SHEET =
	"|RECORD=31|FONTIDCOUNT=1|SIZE1=10|FONTNAME1=Times New Roman|SYSTEMFONT=1|BORDERON=T|SHEETSTYLE=6" +
	"|AREACOLOR=16317695|CUSTOMMARGINWIDTH=20|CUSTOMXZONES=6|CUSTOMYZONES=4"

function render(sheetFields: string, extra: string[] = []) {
	const doc = parseAltiumSchDoc([HEADER, SHEET + sheetFields, ...extra].join("\r\n"))
	// margin 0: SVG x = Altium x, SVG y = 950 - Altium y on a B sheet
	return serializeAltiumSheetToSvg(doc, { margin: 0, documentName: "Motor.SchDoc", currentDate: "1/22/2026" })
}

function group(svg: string, name: string): string {
	const m = new RegExp(`<g data-record="${name}"[\\s\\S]*?</g>`).exec(svg)
	return m?.[0] ?? ""
}

test("draws Altium's border: paper colour, black lines, zone ticks on the outer sheet split", () => {
	const svg = render("|TITLEBLOCKON=T")
	const border = group(svg, "SheetBorder")
	expect(border).toContain('fill="#fffcf8"')
	expect(border).toContain('stroke="#000000" stroke-width="0.3"')
	// B sheet 1500 wide in 6 zones: ticks at x = 250, 500 ... in the 20-unit border band
	expect(border).toContain("M 250 0 V 20")
	expect(border).toContain("M 1250 930 V 950")
})

test("labels zones 1-6 left to right and A-D top to bottom on all four sides", () => {
	const zones = group(render("|TITLEBLOCKON=T"), "SheetZones")
	for (const label of ["1", "2", "3", "4", "5", "6", "A", "B", "C", "D"]) expect(zones).toContain(`>${label}</text>`)
	// "1" centred in the first 250-unit zone of the top band; "A" in the top row of the left band
	expect(zones).toMatch(/<text x="125" y="10"[^>]*>1<\/text>/)
	expect(zones).toMatch(/<text x="10" y="118.75"[^>]*>A<\/text>/)
})

test("draws the standard title block in the inner corner; Altium fills only Size, Date and File", () => {
	const svg = render("|TITLEBLOCKON=T", ["|RECORD=41|NAME=Title|TEXT=Motor driver|ISHIDDEN=T|INDEXINSHEET=-1"])
	const tb = group(svg, "TitleBlock")
	expect(tb).toContain("M 1130 850 H 1480") // top edge, y = 100
	expect(tb).toContain("M 1130 930 V 850") // left edge from inner border (y = 20) to y = 100
	for (const label of ["Title", "Size", "Number", "Revision", "Date:", "File:", "Sheet", "Drawn By:"]) expect(tb).toContain(`>${label}</text>`)
	expect(tb).toContain(">B</text>")
	expect(tb).not.toContain("Motor driver") // the Title parameter is shown only by the user's own =Title text
	expect(tb).toContain(">Motor.SchDoc</text>")
	expect(tb).toContain(">1/22/2026</text>")
})

test("no standard title block when it is switched off or a sheet template draws its own", () => {
	expect(group(render(""), "TitleBlock")).toBe("")
	expect(group(render("|TITLEBLOCKON=T", ["|RECORD=39|ISNOTACCESIBLE=T|OWNERPARTID=-1|FILENAME=Raise.SchDot"]), "TitleBlock")).toBe("")
})
