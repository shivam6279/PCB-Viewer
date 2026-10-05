import { expect, test } from "vitest"
import { parseAltiumSchDoc } from "altiumts"
import { getSchematicFont } from "./get-schematic-font"

function font(name: string, size: number) {
	const doc = parseAltiumSchDoc(
		[
			"|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=2",
			`|RECORD=31|FONTIDCOUNT=1|SIZE1=${size}|FONTNAME1=${name}|SYSTEMFONT=1`,
			"|RECORD=4|LOCATION.X=0|LOCATION.Y=0|TEXT=x|FONTID=1",
		].join("\r\n"),
	)
	const sheet = doc.records.find(r => r.recordKind === "31") as never
	const label = doc.records.find(r => r.recordKind === "4")!
	return getSchematicFont({ record: label, sheetRecord: sheet })
}

// Altium treats a font size as the Windows cell height (ascent + descent), so the em is smaller.
// Expected values for the Cubli project's sheets.
test.each([
	["Times New Roman", 10, 8.92],
	["Consolas", 10, 8.62],
	["Consolas", 12, 10.11],
])("%s %i prints at an em of about %f sheet units", (name, size, em) => {
	expect(font(name, size).size).toBeCloseTo(em, 0)
	expect(Math.abs(font(name, size).size - em)).toBeLessThan(0.2)
})

test("unknown families fall back to a typical cell-height ratio", () => {
	const size = font("Some Font", 10).size
	expect(size).toBeGreaterThan(8.3)
	expect(size).toBeLessThan(9.2)
})
