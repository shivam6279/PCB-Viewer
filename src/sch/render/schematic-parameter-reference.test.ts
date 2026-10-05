import { expect, test } from "vitest"
import { parseAltiumSchDoc } from "altiumts"
import { serializeAltiumSheetToSvg } from "./serialize-altium-sheet-to-svg"

test("a parameter reference whose name has a space (=Part Number) resolves", () => {
	const doc = parseAltiumSchDoc(
		[
			"|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=4",
			"|RECORD=31|SHEETSTYLE=6",
			"|RECORD=1|INDEXINSHEET=0|LIBREFERENCE=CONN4|LOCATION.X=100|LOCATION.Y=100|CURRENTPARTID=1",
			"|RECORD=41|OWNERINDEX=1|NAME=Part Number|TEXT=BM04B-SRSS-TB(LF)(SN)|ISHIDDEN=T|LOCATION.X=100|LOCATION.Y=90",
			"|RECORD=41|OWNERINDEX=1|NAME=Comment|TEXT==Part Number|LOCATION.X=100|LOCATION.Y=80",
		].join("\r\n"),
	)
	const svg = serializeAltiumSheetToSvg(doc, { margin: 0 })
	expect(svg).toContain(">BM04B-SRSS-TB(LF)(SN)</text>")
	expect(svg).not.toContain("=Part Number")
})

test("names ending in s and trailing spaces resolve to the whole name", () => {
	const doc = parseAltiumSchDoc(
		[
			"|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=3",
			"|RECORD=31|SHEETSTYLE=6",
			"|RECORD=41|NAME=Pins|TEXT=64|ISHIDDEN=T|INDEXINSHEET=-1",
			"|RECORD=4|LOCATION.X=10|LOCATION.Y=10|TEXT==Pins ",
		].join("\r\n"),
	)
	expect(serializeAltiumSheetToSvg(doc, { margin: 0 })).toContain(">64</text>")
})
