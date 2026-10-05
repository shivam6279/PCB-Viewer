import { expect, test } from "vitest"
import { parseAltiumSchDoc } from "altiumts"
import { serializeAltiumSheetToSvg } from "./serialize-altium-sheet-to-svg"

// Expected geometry/colours for Cubli ESC_MCU.SchDoc (I2C harness connector and port).
// SVG x = Altium x, SVG y = 950 - Altium y (B sheet, margin 0).
const HEADER = "|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=9"
const SHEET = "|RECORD=31|FONTIDCOUNT=1|SIZE1=10|FONTNAME1=Times New Roman|SYSTEMFONT=1|SHEETSTYLE=6"

function render(records: string[], additional: string[] = []) {
	const doc = parseAltiumSchDoc([HEADER, SHEET, ...records].join("\r\n"))
	const extra = additional.length ? parseAltiumSchDoc([HEADER, ...additional].join("\r\n")).records.filter(r => r.recordKind) : []
	return serializeAltiumSheetToSvg(doc, { margin: 0, additionalRecords: extra })
}

const group = (svg: string, kind: string) => new RegExp(`<g data-record="${kind}"[^>]*>[\\s\\S]*?</g>`).exec(svg)?.[0] ?? ""

test("a port's point is half its height deep and outlined with a hairline", () => {
	const port = group(render(["|RECORD=18|IOTYPE=1|ALIGNMENT=1|WIDTH=60|LOCATION.X=130|LOCATION.Y=350|COLOR=128|FONTID=1|AREACOLOR=8454143|TEXTCOLOR=128|NAME=CAN_S|HEIGHT=10"]), "18")
	expect(port).toContain('stroke-width="0.3"')
	expect(port).toContain("H 185 L 190 600") // shoulder 5 units before the tip (direction comes from the attached wire)
	expect(port).toMatch(/<text x="140"[^>]*text-anchor="start"[^>]*>CAN_S<\/text>/) // left aligned, 10 in
})

test("a harness port is drawn in harness blue over a grey shadow", () => {
	const port = group(render(["|RECORD=18|ALIGNMENT=1|WIDTH=50|LOCATION.X=120|LOCATION.Y=210|COLOR=128|FONTID=1|AREACOLOR=8454143|TEXTCOLOR=128|NAME=I2C|HARNESSTYPE=I2C|HEIGHT=10"]), "18")
	const fills = [...port.matchAll(/fill="(#[0-9a-f]{6})" stroke="(#[0-9a-f]{6})"/g)].map(m => `${m[1]}/${m[2]}`)
	expect(fills).toEqual(["#bac0ca/#a6acb6", "#d5e4ff/#71809b"])
})

const CONNECTOR = "|RECORD=215|INDEXINSHEET=39|LOCATION.X=170|LOCATION.Y=230|XSIZE=50|YSIZE=30|LINEWIDTH=1|COLOR=13213327|AREACOLOR=16511725|PRIMARYCONNECTIONPOSITION=20"
const ENTRY = (name: string, dft: number) =>
	`|RECORD=216|OWNERINDEXADDITIONALLIST=T|SIDE=1|DISTANCEFROMTOP=${dft}|COLOR=7354880|AREACOLOR=8454143|TEXTCOLOR=7354880|TEXTFONTID=1|NAME=${name}`
const TYPE_LABEL = "|RECORD=217|OWNERINDEXADDITIONALLIST=T|LOCATION.X=220|LOCATION.Y=230|JUSTIFICATION=2|COLOR=8388608|FONTID=1|TEXT=I2C"

test("a harness connector: area fill, brace on the left, dots and names for its entries, type label above", () => {
	const svg = render([], [CONNECTOR, ENTRY("SDA", 1), ENTRY("SCL", 2), TYPE_LABEL])
	const c = group(svg, "215")
	expect(c).toContain('fill="#edf2fb"')
	expect(c).toMatch(/stroke="#8f9ec9"/)
	// Brace: down the inset left side (x = 175) to a tip at the primary connection (x = 170, y = 230 - 20).
	expect(c).toContain("L 175 735")
	expect(c).toContain("170 740")
	// Entry dots on the right edge, 10 units apart, in the entry colour; names right-aligned 5 units in.
	expect(c).toMatch(/<circle cx="220" cy="730" r="1" fill="#003a70"/)
	expect(c).toMatch(/<circle cx="220" cy="740" r="1" fill="#003a70"/)
	expect(c).toMatch(/<text x="215" y="730" text-anchor="end"[^>]*fill="#003a70"[^>]*>SDA<\/text>/)
	expect(c).toMatch(/<text x="220" y="720" text-anchor="end"[^>]*fill="#000080"[^>]*>I2C<\/text>/)
})

test("a harness wire: light band, slanted ticks every 10 units, thin centre line", () => {
	const svg = render([], ["|RECORD=218|INDEXINSHEET=221|LINEWIDTH=2|COLOR=15187117|LOCATIONCOUNT=2|X1=1000|Y1=720|X2=1070|Y2=720"])
	const w = group(svg, "218")
	expect(w).toMatch(/points="1000,230 1070,230" fill="none" stroke="#cbdaff" stroke-width="5.1"/)
	expect(w).toMatch(/points="1000,230 1070,230" fill="none" stroke="#adbce7" stroke-width="1"/)
	expect((w.match(/<line /g) ?? []).length).toBe(7)
	expect(w).toContain('<line x1="1002" y1="228.3" x2="1005.9" y2="231.8"')
})

test("a harness port is pointed at both ends", () => {
	const port = group(render(["|RECORD=18|ALIGNMENT=1|WIDTH=50|LOCATION.X=120|LOCATION.Y=210|COLOR=128|FONTID=1|NAME=I2C|HARNESSTYPE=I2C|HEIGHT=10"]), "18")
	expect(port).toContain('d="M 120 740 L 125 735 H 165 L 170 740 L 165 745 H 125 Z"')
})
