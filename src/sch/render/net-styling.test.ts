import { expect, test } from "vitest"
import { parseAltiumSchDoc } from "altiumts"
import { serializeAltiumSheetToSvg } from "./serialize-altium-sheet-to-svg"

// Cubli Top.SchDoc. SVG x = sheet x, SVG y = 950 - sheet y (B sheet, margin 0).
function render(records: string[], netColors?: Record<string, string>) {
	const doc = parseAltiumSchDoc(
		[
			"|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=9",
			"|RECORD=31|FONTIDCOUNT=1|SIZE1=10|FONTNAME1=Times New Roman|SYSTEMFONT=1|SHEETSTYLE=6",
			...records,
		].join("\r\n"),
	)
	return serializeAltiumSheetToSvg(doc, { margin: 0, netColors })
}

const WIRE = "|RECORD=27|INDEXINSHEET=1|LINEWIDTH=1|COLOR=8388608|LOCATIONCOUNT=2|X1=610|Y1=770|X2=640|Y2=770"
const PORT_12V = "|RECORD=17|INDEXINSHEET=2|STYLE=1|SHOWNETNAME=T|LOCATION.X=610|LOCATION.Y=770|ORIENTATION=2|COLOR=128|TEXT=12V"

test("an arrow power port is a short stem and a hollow triangle", () => {
	const port = /<g data-record="17">([\s\S]*?)<\/g>/.exec(render([PORT_12V]))![1]!
	expect(port).toContain("M 610 180 L 605.9 180") // 4.1-unit stem
	expect(port).toContain("M 605.9 183 L 600 180 L 605.9 177 Z") // triangle: base at 4.1 (±3), tip at 10
	expect(port).toMatch(/<path d="M 605\.9 183[^"]*" fill="none"/)
})

test("a wire on a coloured net gets a 5.1-unit band of the net colour underneath", () => {
	const svg = render([WIRE, PORT_12V], { "12v": "#fd8300" })
	const band = /<polyline data-net-color="12V" points="610,180 640,180" fill="none" stroke="#fd8300" stroke-width="5.1"/.exec(svg)
	expect(band).toBeTruthy()
	expect(svg.indexOf("data-net-color")).toBeLessThan(svg.indexOf('data-record="27"')) // under the wire
})

test("wires on nets without a colour get no band", () => {
	expect(render([WIRE, PORT_12V], { gnd: "#ffff00" })).not.toContain("data-net-color")
	expect(render([WIRE, PORT_12V])).not.toContain("data-net-color")
})

test("a junction takes the colour of the wires it joins", () => {
	const svg = render([
		WIRE,
		"|RECORD=27|INDEXINSHEET=3|LINEWIDTH=1|COLOR=8388608|LOCATIONCOUNT=2|X1=620|Y1=770|X2=620|Y2=740",
		"|RECORD=29|INDEXINSHEET=4|LOCATION.X=620|LOCATION.Y=770|COLOR=128",
	])
	expect(svg).toMatch(/<circle data-record="29"[^>]*fill="#000080"/)
})

test("designators on a channel sheet are renamed with the project's channel designator format", () => {
	const doc = parseAltiumSchDoc(
		[
			"|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=3",
			"|RECORD=31|SHEETSTYLE=6",
			"|RECORD=1|INDEXINSHEET=0|LIBREFERENCE=LED|LOCATION.X=100|LOCATION.Y=100|CURRENTPARTID=1",
			"|RECORD=34|OWNERINDEX=1|NAME=Designator|TEXT=D5_ESC|LOCATION.X=100|LOCATION.Y=110",
		].join("\r\n"),
	)
	const svg = serializeAltiumSheetToSvg(doc, { margin: 0, channel: { index: 1, name: "U_ESC1", designatorFormat: "$Component_$ChannelIndex" } })
	expect(svg).toContain(">D5_ESC_1<tspan fill=\"#8c8c8c\" font-size=\"0.8em\"> (D5_ESC)</tspan></text>")
	expect(serializeAltiumSheetToSvg(doc, { margin: 0 })).toContain(">D5_ESC</text>")
})
