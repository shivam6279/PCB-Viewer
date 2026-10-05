// Sheet border, zone labels and the standard title block. Not part of the vendored
// altiumts renderer.
import type { AltiumSchSheetRecord } from "altiumts"
import { altiumColorToCss, readSchematicInteger } from "./altium-values"
import { getSchematicFont } from "./get-schematic-font"
import type { SvgViewport } from "./svg-types"
import { escapeXml, formatSvgNumber, HAIRLINE_WIDTH } from "./svg-utils"

const SHEET_STYLE_NAMES = [
	"A4", "A3", "A2", "A1", "A0", "A", "B", "C", "D", "E",
	"Letter", "Legal", "Tabloid", "OrCAD A", "OrCAD B", "OrCAD C", "OrCAD D", "OrCAD E",
]

// Standard title block, relative to the inner border's bottom-right corner (Altium units).
const TB_WIDTH = 350
const TB_ROWS = { file: 10, date: 20, size: 50, title: 80 }
const TB_COLS = { number: 50, revision: 250, sheet: 200 }

export interface SheetFrameInput {
	sheetRecord: AltiumSchSheetRecord | undefined
	viewport: SvgViewport
	sheetWidth: number
	sheetHeight: number
	hasTemplate: boolean
	documentName: string | undefined
	currentDate: string | undefined
}

export function renderSchematicSheetFrame(input: SheetFrameInput): string {
	const { sheetRecord, viewport: vp, sheetWidth: w, sheetHeight: h } = input
	const margin = Math.max(readSchematicInteger(sheetRecord?.getCaseInsensitive("CUSTOMMARGINWIDTH"), 20), 4)
	const xZones = Math.max(readSchematicInteger(sheetRecord?.getCaseInsensitive("CUSTOMXZONES"), 6), 1)
	const yZones = Math.max(readSchematicInteger(sheetRecord?.getCaseInsensitive("CUSTOMYZONES"), 4), 1)
	const ink = altiumColorToCss(sheetRecord?.getCaseInsensitive("COLOR"), "#000000")
	const paper = altiumColorToCss(sheetRecord?.getCaseInsensitive("AREACOLOR"), "#fffcf8")
	const font = sheetRecord ? getSchematicFont({ record: sheetRecord, sheetRecord }) : undefined
	const fontAttrs = font?.attributes ?? 'font-family="Times New Roman" font-size="10"'
	const X = (x: number) => formatSvgNumber(vp.toX(x))
	const Y = (y: number) => formatSvgNumber(vp.toY(y))
	const stroke = `stroke="${ink}" stroke-width="${formatSvgNumber(HAIRLINE_WIDTH)}"`

	const ticks: string[] = []
	for (let i = 1; i < xZones; i++) {
		const x = (w * i) / xZones
		ticks.push(`M ${X(x)} ${Y(h)} V ${Y(h - margin)}`, `M ${X(x)} ${Y(margin)} V ${Y(0)}`)
	}
	for (let i = 1; i < yZones; i++) {
		const y = (h * i) / yZones
		ticks.push(`M ${X(0)} ${Y(y)} H ${X(margin)}`, `M ${X(w - margin)} ${Y(y)} H ${X(w)}`)
	}
	const border =
		`<g data-record="SheetBorder" fill="none" ${stroke}>` +
		`<rect x="${X(0)}" y="${Y(h)}" width="${formatSvgNumber(w)}" height="${formatSvgNumber(h)}" fill="${paper}"/>` +
		`<rect x="${X(margin)}" y="${Y(h - margin)}" width="${formatSvgNumber(w - 2 * margin)}" height="${formatSvgNumber(h - 2 * margin)}"/>` +
		`<path d="${ticks.join(" ")}"/></g>`

	const label = (x: number, y: number, text: string) =>
		`<text x="${X(x)}" y="${Y(y)}" ${fontAttrs} fill="${ink}" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>`
	const zoneLabels: string[] = []
	for (let i = 0; i < xZones; i++) {
		const x = (w * (i + 0.5)) / xZones
		zoneLabels.push(label(x, h - margin / 2, String(i + 1)), label(x, margin / 2, String(i + 1)))
	}
	for (let i = 0; i < yZones; i++) {
		const y = h - (h * (i + 0.5)) / yZones
		const letter = String.fromCharCode(65 + i)
		zoneLabels.push(label(margin / 2, y, letter), label(w - margin / 2, y, letter))
	}
	const zones = `<g data-record="SheetZones">${zoneLabels.join("")}</g>`

	const showTitleBlock = sheetRecord?.getBoolean("TITLEBLOCKON") === true && !input.hasTemplate
	return border + zones + (showTitleBlock ? renderStandardTitleBlock(input, w - margin, margin, X, Y, stroke, fontAttrs, ink) : "")
}

function renderStandardTitleBlock(
	input: SheetFrameInput,
	right: number,
	bottom: number,
	X: (x: number) => string,
	Y: (y: number) => string,
	stroke: string,
	fontAttrs: string,
	ink: string,
): string {
	const L = right - TB_WIDTH
	const B = bottom
	const hLine = (y: number) => `M ${X(L)} ${Y(B + y)} H ${X(right)}`
	const vLine = (x: number, y0: number, y1: number) => `M ${X(L + x)} ${Y(B + y0)} V ${Y(B + y1)}`
	const lines = [
		hLine(TB_ROWS.title),
		hLine(TB_ROWS.size),
		hLine(TB_ROWS.date),
		hLine(TB_ROWS.file),
		vLine(0, 0, TB_ROWS.title),
		vLine(TB_COLS.number, TB_ROWS.date, TB_ROWS.size),
		vLine(TB_COLS.revision, TB_ROWS.date, TB_ROWS.size),
		vLine(TB_COLS.sheet, 0, TB_ROWS.date),
	]

	const text = (x: number, y: number, value: string | undefined) =>
		value ? `<text x="${X(L + x)}" y="${Y(B + y)}" ${fontAttrs} fill="${ink}">${escapeXml(value)}</text>` : ""
	const style = input.sheetRecord?.getCaseInsensitive("SHEETSTYLE")
	const useCustom = input.sheetRecord?.getCaseInsensitive("USECUSTOMSHEET") === "T"
	const sizeName = useCustom || style === undefined ? "Custom" : SHEET_STYLE_NAMES[Number(style)] ?? ""

	// Altium fills only Size, Date and File itself; Title, Number, Revision etc. are left for the
	// user's own special-string text objects, which are ordinary sheet records.
	const texts = [
		text(5, 71.9, "Title"),
		text(5, 41.8, "Size"),
		text(10, 26.9, sizeName),
		text(55, 41.8, "Number"),
		text(255, 41.8, "Revision"),
		text(5, 11.9, "Date:"),
		text(50, 11.9, input.currentDate),
		text(205, 11.9, "Sheet"),
		text(233, 11.9, "of"),
		text(5, 1.8, "File:"),
		text(50, 1.8, input.documentName),
		text(205, 1.8, "Drawn By:"),
	]
	return `<g data-record="TitleBlock"><path d="${lines.join(" ")}" fill="none" ${stroke}/>${texts.join("")}</g>`
}
