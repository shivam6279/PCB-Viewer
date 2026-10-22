// The sheet's own fonts from this computer (Consolas, Times New Roman...), embedded in the PDF so it
// reads as the view does. The browser asks once for permission; without it, or without the font,
// the PDF's standard fonts stand in (svg-for-pdf.ts).
import type { jsPDF } from "jspdf"

export interface LocalFont {
	family: string
	style: string // "Regular", "Bold", "Italic", "Bold Italic"
	blob(): Promise<Blob>
}

declare global {
	interface Window {
		queryLocalFonts?: () => Promise<LocalFont[]>
	}
}

// Must be called straight from the click (the permission prompt needs the user's gesture).
export async function queryLocalFonts(): Promise<LocalFont[]> {
	try {
		return (await window.queryLocalFonts?.()) ?? []
	} catch {
		return [] // refused, or not offered by this browser
	}
}

export type PdfStyle = "normal" | "bold" | "italic" | "bolditalic"

export const pdfStyle = (weight: string | null, style: string | null): PdfStyle => {
	const bold = weight === "bold" || Number(weight) >= 600
	const italic = /italic|oblique/.test(style ?? "")
	return bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "normal"
}

const LOCAL_STYLE: Record<PdfStyle, RegExp> = {
	normal: /^(regular|normal|book|roman)$/i,
	bold: /^bold$/i,
	italic: /^(italic|oblique)$/i,
	bolditalic: /^bold (italic|oblique)$/i,
}

// The font id embedded for a family ("emb-consolas"), or undefined.
export type Embedded = Map<string, string>

// Embeds every wanted family found locally, each style the sheets use (a missing style takes the
// regular face). Only TrueType outlines can be embedded; other fonts are left to stand-ins.
export async function embedLocalFonts(pdf: jsPDF, fonts: LocalFont[], wanted: Map<string, Set<PdfStyle>>): Promise<Embedded> {
	const embedded: Embedded = new Map()
	for (const [family, styles] of wanted) {
		const faces = fonts.filter(f => f.family.toLowerCase() === family)
		const regular = faces.find(f => LOCAL_STYLE.normal.test(f.style.trim()))
		if (!regular) continue
		const id = `emb-${family.replaceAll(/[^a-z0-9]+/g, "-")}`
		let ok = false
		for (const style of new Set<PdfStyle>(["normal", ...styles])) {
			const face: LocalFont = faces.find(f => LOCAL_STYLE[style].test(f.style.trim())) ?? regular
			let bytes = new Uint8Array(await (await face.blob()).arrayBuffer())
			if (!isTrueType(bytes) && face !== regular) bytes = new Uint8Array(await (await regular.blob()).arrayBuffer())
			if (!isTrueType(bytes)) continue
			const file = `${id}-${style}.ttf`
			pdf.addFileToVFS(file, toBase64(bytes))
			pdf.addFont(file, id, style, undefined, "Identity-H")
			ok = true
		}
		if (ok) embedded.set(family, id)
	}
	return embedded
}

function isTrueType(b: Uint8Array): boolean {
	const tag = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!)
	return tag === "\0\x01\0\0" || tag === "true"
}

function toBase64(bytes: Uint8Array): string {
	let s = ""
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return btoa(s)
}
