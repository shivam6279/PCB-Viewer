// @vitest-environment jsdom
import { describe, expect, test } from "vitest"
import { jsPDF } from "jspdf"
import { baselineShift, fontFit, prepareSvgForPdf, toCp1252 } from "./svg-for-pdf"

const svgOf = (inner: string) => {
	const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`, "image/svg+xml")
	return doc.documentElement as unknown as SVGSVGElement
}

describe("svg for the PDF", () => {
	test("sheet fonts map to the nearest standard font; Consolas is narrowed to its width", () => {
		expect(fontFit("Times New Roman").pdf).toBe("times")
		expect(fontFit("Arial").pdf).toBe("helvetica")
		expect(fontFit("Microsoft Sans Serif").pdf).toBe("helvetica")
		expect(fontFit("Courier New").pdf).toBe("courier")
		expect(fontFit("Consolas")).toMatchObject({ pdf: "courier" })
		expect(fontFit("Consolas").scale).toBeCloseTo(0.916, 3)
	})

	test("baselines: central sits half the font's height above, bottom edges by the descent", () => {
		const times = fontFit("Times New Roman")
		expect(baselineShift("central", times)).toBeCloseTo((0.891 - 0.216) / 2)
		expect(baselineShift("text-after-edge", times)).toBeCloseTo(-0.216)
		expect(baselineShift(null, times)).toBe(0)
	})

	test("a negated name gets a line over just its negated run, in the text's own transform", () => {
		const svg = svgOf(
			'<text x="0" y="0" fill="#123456" font-family="Arial" font-size="10" text-anchor="start" dominant-baseline="central" transform="translate(100 50) rotate(90)"><tspan text-decoration="overline">RST</tspan>/IO</text>',
		)
		prepareSvgForPdf(svg, new jsPDF({ unit: "pt" }))
		// The pieces, each its own text placed one after the other, in the original's transform.
		const g = svg.querySelector("g")!
		expect(g.getAttribute("transform")).toBe("translate(100 50) rotate(90)")
		const texts = [...g.querySelectorAll("text")]
		expect(texts.map(t => t.textContent)).toEqual(["RST", "/IO"])
		for (const t of texts) {
			expect(t.getAttribute("font-family")).toBe("helvetica")
			expect(t.hasAttribute("dominant-baseline")).toBe(false)
			expect(t.getAttribute("text-anchor")).toBe("start")
			expect(t.hasAttribute("transform")).toBe(false)
			expect(Number(t.getAttribute("y"))).toBeCloseTo(((0.905 - 0.212) / 2) * 10)
		}
		expect(Number(texts[0]!.getAttribute("x"))).toBe(0)
		expect(Number(texts[1]!.getAttribute("x"))).toBeGreaterThan(15)
		const lines = g.querySelectorAll("line")
		expect(lines).toHaveLength(1)
		expect(Number(lines[0]!.getAttribute("x1"))).toBe(0)
		expect(Number(lines[0]!.getAttribute("x2"))).toBeGreaterThan(15) // "RST", not the whole name
		expect(Number(lines[0]!.getAttribute("x2"))).toBeLessThan(25)
		expect(lines[0]!.getAttribute("stroke")).toBe("#123456")
	})

	test("characters the standard fonts lack become the nearest they have", () => {
		expect(toCp1252("10kΩ ±5% ≤ 3–")).toBe("10kOhm ±5% <= 3–")
		expect(toCp1252("中")).toBe("?")
	})
})

test("a styled piece (a logical page's *) keeps its colour and slant; an end-anchored text ends where it did", () => {
	const svg = svgOf('<text x="200" y="0" fill="#000080" font-family="Arial" font-size="10" text-anchor="end">R1_CAN<tspan font-style="italic" fill="#c2410c">*</tspan></text>')
	const pdf = new jsPDF({ unit: "pt" })
	prepareSvgForPdf(svg, pdf)
	const [name, star] = [...svg.querySelectorAll("text")]
	expect(name!.getAttribute("fill")).toBe("#000080")
	expect(star!.getAttribute("fill")).toBe("#c2410c")
	expect(star!.getAttribute("font-style")).toBe("italic")
	pdf.setFont("helvetica", "italic")
	const end = Number(star!.getAttribute("x")) + pdf.getStringUnitWidth("*") * 10
	expect(end).toBeCloseTo(200)
})
