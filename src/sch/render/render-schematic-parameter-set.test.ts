import { expect, test } from "vitest"
import { parseAltiumSchDoc } from "altiumts"
import { serializeAltiumSheetToSvg } from "./serialize-altium-sheet-to-svg"

const HEADER = "|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=3"
const SHEET = "|RECORD=31|FONTIDCOUNT=1|SIZE1=10|FONTNAME1=Times New Roman|SYSTEMFONT=1|SHEETSTYLE=6"

function directive(fields: string): string {
	const doc = parseAltiumSchDoc([HEADER, SHEET, `|RECORD=43|LOCATION.X=100|LOCATION.Y=200|COLOR=255${fields}`].join("\r\n"))
	// margin 0: SVG x = Altium x, SVG y = 950 - Altium y on a B sheet
	const svg = serializeAltiumSheetToSvg(doc, { margin: 0 })
	return /<g data-record="43">[\s\S]*?<\/g>|<path data-record="43"[^>]*\/>/.exec(svg)?.[0] ?? ""
}

test("a generic directive is a stem, a circled i and its name, in the directive's colour", () => {
	const g = directive("|NAME=S50")
	expect(g).toContain('d="M 100 750 L 106 750"')
	expect(g).toContain('<circle cx="112" cy="750" r="6"')
	expect(g).toMatch(/text-anchor="middle"[^>]*translate\(112 750\)[^>]*>i<\/text>/)
	expect(g).toMatch(/text-anchor="start"[^>]*translate\(120 750\)[^>]*>S50<\/text>/)
	expect(g).toContain('stroke="#ff0000"')
})

test("rotates with orientation and keeps the name readable", () => {
	const up = directive("|NAME=24V|ORIENTATION=1")
	expect(up).toContain('<circle cx="100" cy="738"')
	expect(up).toMatch(/text-anchor="start"[^>]*translate\(100 730\) rotate\(-90\)[^>]*>24V</)
	const left = directive("|NAME=24V|ORIENTATION=2")
	expect(left).toMatch(/text-anchor="end"[^>]*translate\(80 750\) rotate\(0\)[^>]*>24V</)
})

test("a DIFFPAIR directive is the two-track icon with no circle and no name", () => {
	const p = directive("|NAME=DIFFPAIR")
	expect(p.startsWith("<path")).toBe(true)
	expect(p).toContain("M 100 750 L 104 746 L 108 746 L 110 748 L 115 748 L 117 746 L 121 746")
	expect(p).toContain("M 104 743.5 L 108 743.5 L 110 741.5 L 115 741.5 L 117 743.5 L 121 743.5")
	expect(p).not.toContain("DIFFPAIR")
})
