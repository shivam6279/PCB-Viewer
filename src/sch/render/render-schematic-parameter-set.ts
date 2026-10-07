// Parameter Set directive (RECORD=43). Not part of the vendored altiumts renderer.
// Geometry measured off Altium's own documentation renders, in Altium units against the
// visible grid and the wire pitch: a generic directive is a stem, a circled "i" and the
// name; a DIFFPAIR directive is the two-track icon alone, its name never drawn.
import type { AltiumRecord, AltiumSchSheetRecord } from "altiumts"
import { getSchematicFont } from "./get-schematic-font"
import type { SvgPoint, SvgViewport } from "./svg-types"
import { escapeXml, formatSvgNumber } from "./svg-utils"

const STROKE = 1
const STEM_LENGTH = 6
const CIRCLE_RADIUS = 6
const CIRCLE_CENTER = STEM_LENGTH + CIRCLE_RADIUS
const TEXT_OFFSET = 20

// Local frame: attach point at the origin, icon pointing +x, y up.
const DIFF_PAIR_TRACKS: [number, number][][] = [
	[[0, 0], [4, 4], [8, 4], [10, 2], [15, 2], [17, 4], [21, 4]],
	[[4, 6.5], [8, 6.5], [10, 8.5], [15, 8.5], [17, 6.5], [21, 6.5]],
]

export function isDiffPairDirective(record: AltiumRecord): boolean {
	return record.getDecoded("NAME")?.trim().toUpperCase() === "DIFFPAIR"
}

export function renderSchematicParameterSet(params: {
	record: AltiumRecord
	location: SvgPoint
	sheetRecord: AltiumSchSheetRecord | undefined
	viewport: SvgViewport
	metadata: string
	color: string
	showText: boolean
}): string {
	const { record, location: origin, sheetRecord, viewport, metadata, color, showText } = params
	const orientation = ((Math.round(record.getNumber("ORIENTATION") ?? 0) % 4) + 4) % 4
	// Rotate local (x, y) by orientation * 90 degrees counter-clockwise, then into SVG space.
	const at = (x: number, y: number) => {
		const [rx, ry] = ([[x, y], [-y, x], [-x, -y], [y, -x]] as const)[orientation as 0 | 1 | 2 | 3]
		return { x: viewport.toX(origin.x + rx), y: viewport.toY(origin.y + ry) }
	}
	const n = formatSvgNumber
	const lineAttrs = `fill="none" stroke="${color}" stroke-width="${n(STROKE)}" stroke-linecap="round" stroke-linejoin="round"`

	if (isDiffPairDirective(record)) {
		const d = DIFF_PAIR_TRACKS.map(track =>
			track.map(([x, y], i) => {
				const p = at(x, y)
				return `${i === 0 ? "M" : "L"} ${n(p.x)} ${n(p.y)}`
			}).join(" "),
		).join(" ")
		return `<path ${metadata} d="${d}" ${lineAttrs}/>`
	}

	const font = getSchematicFont({ record, sheetRecord })
	// Altium keeps text upright: leftwards/downwards flips the anchor instead of the glyphs.
	const rotation = orientation === 1 || orientation === 3 ? -90 : 0
	const anchor = orientation === 2 || orientation === 3 ? "end" : "start"
	const text = (p: { x: number; y: number }, textAnchor: string, content: string) =>
		`<text x="0" y="0" fill="${color}" ${font.attributes} text-anchor="${textAnchor}" dominant-baseline="central" transform="translate(${n(p.x)} ${n(p.y)}) rotate(${n(rotation)})">${content}</text>`

	const stemStart = at(0, 0)
	const stemEnd = at(STEM_LENGTH, 0)
	const center = at(CIRCLE_CENTER, 0)
	const parts = [
		`<path d="M ${n(stemStart.x)} ${n(stemStart.y)} L ${n(stemEnd.x)} ${n(stemEnd.y)}" ${lineAttrs}/>`,
		`<circle cx="${n(center.x)}" cy="${n(center.y)}" r="${n(CIRCLE_RADIUS)}" ${lineAttrs}/>`,
		text(center, "middle", "i"),
	]
	const name = record.getDecoded("NAME") ?? ""
	if (name && showText) parts.push(text(at(TEXT_OFFSET, 0), anchor, escapeXml(name)))
	return `<g ${metadata}>${parts.join("")}</g>`
}
