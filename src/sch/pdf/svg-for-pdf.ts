// Readies a sheet's SVG for svg2pdf, which knows neither dominant-baseline nor text-decoration: each
// text gets the sheet's own font when it is embedded (local-fonts.ts), else the standard PDF font
// closest to it; its baseline is worked out from the sheet font's metrics, and its overlines
// (negated names) and underlines are drawn as lines.
import type { jsPDF } from "jspdf"
import { pdfStyle, type Embedded } from "./local-fonts"

const SVG_NS = "http://www.w3.org/2000/svg"

interface FontFit {
	pdf: string // a standard font, or an embedded one's id
	embedded?: boolean
	ascent: number // em, of the sheet's font
	descent: number
	scale: number // font size factor so a run is as wide as in the sheet's font
}

const TIMES: FontFit = { pdf: "times", ascent: 0.891, descent: 0.216, scale: 1 }
const HELVETICA: FontFit = { pdf: "helvetica", ascent: 0.905, descent: 0.212, scale: 1 }
const COURIER: FontFit = { pdf: "courier", ascent: 0.833, descent: 0.3, scale: 1 }
const CONSOLAS: FontFit = { pdf: "courier", ascent: 0.743, descent: 0.257, scale: 0.5498 / 0.6 }

export function fontFit(family: string, embedded: Embedded = new Map()): FontFit {
	const f = family.toLowerCase().replaceAll(/["']/g, "").trim()
	const own = embedded.get(f)
	if (own) return { ...metricsOf(f), pdf: own, embedded: true, scale: 1 }
	return metricsOf(f)
}

function metricsOf(f: string): FontFit {
	if (f.includes("consolas")) return CONSOLAS
	if (/courier|mono|lucida console/.test(f)) return COURIER
	if (/times|serif|georgia|garamond|cambria/.test(f) && !f.includes("sans")) return TIMES
	return HELVETICA
}

// Where the alphabetic baseline sits below the text's y, in em, for its dominant-baseline.
export function baselineShift(dominantBaseline: string | null, fit: FontFit): number {
	switch (dominantBaseline) {
		case "central":
		case "middle":
			return (fit.ascent - fit.descent) / 2
		case "text-after-edge":
		case "text-bottom":
		case "ideographic":
			return -fit.descent
		case "text-before-edge":
		case "text-top":
		case "hanging":
			return fit.ascent
		default:
			return 0
	}
}

const num = (el: Element, name: string, fallback = 0) => {
	const v = parseFloat(el.getAttribute(name) ?? "")
	return Number.isFinite(v) ? v : fallback
}

export function prepareSvgForPdf(svg: SVGSVGElement, pdf: jsPDF, embedded: Embedded = new Map()) {
	for (const text of [...svg.querySelectorAll("text")]) {
		const family = text.getAttribute("font-family")
		const fit = fontFit(family ?? "", embedded)
		const size = num(text, "font-size", 10) * fit.scale
		if (family) text.setAttribute("font-family", fit.pdf)
		text.setAttribute("font-size", String(size))
		for (const span of text.querySelectorAll("tspan[font-size]")) span.setAttribute("font-size", String(num(span, "font-size") * fit.scale))

		const shift = baselineShift(text.getAttribute("dominant-baseline"), fit) * size
		text.removeAttribute("dominant-baseline")
		if (shift !== 0) for (const el of [text, ...text.querySelectorAll("tspan[y]")]) el.setAttribute("y", String(num(el, "y") + shift))

		for (const t of layOutPieces(text, fit, size, pdf)) {
			for (const el of [t, ...t.querySelectorAll("tspan")]) el.removeAttribute("text-decoration")
			if (!fit.embedded) pdfSafeText(t)
		}
	}
}

// A text in styled pieces (negated runs, a logical page's *), laid out on one line (no positioned
// tspans): each piece becomes its own text at its measured place, keeping its colour and style (svg2pdf
// leaves gaps between the pieces of an end-anchored text), and over- and underlines become lines.
// Returns the texts now on the page (the text itself when left whole).
function layOutPieces(text: SVGTextElement, fit: FontFit, size: number, pdf: jsPDF): SVGTextElement[] {
	if (![...text.childNodes].some(n => n.nodeType === 1)) return [text]
	if ([...text.children].some(el => ["x", "y", "dx", "dy"].some(a => el.hasAttribute(a)))) return [text]
	const own = text.getAttribute("text-decoration") ?? ""
	const pieces = [...text.childNodes].map(n => {
		const el = n.nodeType === 1 ? (n as Element) : null
		const attr = (name: string) => el?.getAttribute(name) ?? text.getAttribute(name)
		return {
			text: n.textContent ?? "",
			decoration: `${el?.getAttribute("text-decoration") ?? ""} ${own}`,
			fill: attr("fill") ?? "#000000",
			weight: attr("font-weight"),
			style: attr("font-style"),
		}
	})
	const width = (piece: (typeof pieces)[number]) => {
		pdf.setFont(fit.pdf, pdfStyle(piece.weight, piece.style))
		return pdf.getStringUnitWidth(piece.text) * size
	}
	const widths = pieces.map(width)
	const total = widths.reduce((sum, w) => sum + w, 0)
	const anchor = text.getAttribute("text-anchor")
	let x = num(text, "x") - (anchor === "middle" ? total / 2 : anchor === "end" ? total : 0)
	const y = num(text, "y")
	const g = document.createElementNS(SVG_NS, "g")
	const transform = text.getAttribute("transform")
	if (transform) g.setAttribute("transform", transform)
	const runs: SVGTextElement[] = []
	pieces.forEach((piece, k) => {
		const w = widths[k]!
		const run = text.cloneNode(false) as SVGTextElement
		run.removeAttribute("transform")
		run.setAttribute("x", String(x))
		run.setAttribute("text-anchor", "start")
		run.setAttribute("fill", piece.fill)
		if (piece.weight) run.setAttribute("font-weight", piece.weight)
		if (piece.style) run.setAttribute("font-style", piece.style)
		run.textContent = piece.text
		g.appendChild(run)
		runs.push(run)
		for (const [kind, at] of [["overline", y - fit.ascent * size], ["underline", y + 0.12 * size]] as const) {
			if (!piece.decoration.includes(kind)) continue
			const line = document.createElementNS(SVG_NS, "line")
			line.setAttribute("x1", String(x))
			line.setAttribute("x2", String(x + w))
			line.setAttribute("y1", String(at))
			line.setAttribute("y2", String(at))
			line.setAttribute("stroke", piece.fill)
			line.setAttribute("stroke-width", String(size * 0.06))
			g.appendChild(line)
		}
		x += w
	})
	text.replaceWith(g)
	return runs
}

// The standard fonts only cover Windows-1252; other characters become the nearest it has.
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"
const SUBSTITUTES: Record<string, string> = { "Ω": "Ohm", "Ω": "Ohm", "μ": "µ", "≤": "<=", "≥": ">=", "≈": "~", "→": "->", "←": "<-", "−": "-", "∞": "inf" }

export function toCp1252(s: string): string {
	let out = ""
	for (const ch of s) {
		const c = ch.codePointAt(0)!
		out += c < 256 || CP1252_EXTRA.includes(ch) ? ch : (SUBSTITUTES[ch] ?? "?")
	}
	return out
}

function pdfSafeText(text: SVGTextElement) {
	const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const v = n.nodeValue ?? ""
		if (/[^\x00-\xff]/.test(v)) n.nodeValue = toCp1252(v)
	}
}
