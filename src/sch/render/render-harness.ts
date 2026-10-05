// Signal harnesses (connectors, entries, type labels and harness wires). Altium keeps these in the
// SchDoc's "Additional" stream, which altiumts does not render.
import type { AltiumRecord, AltiumSchSheetRecord } from "altiumts"
import { altiumColorToCss, getSchematicCoordinate, getSchematicIndexedPoints, readSchematicInteger } from "./altium-values"
import { getSchematicFont } from "./get-schematic-font"
import type { SvgPoint, SvgViewport } from "./svg-types"
import { ADDITIONAL_BASE } from "../../model/schematic-data"
import { escapeXml, formatSvgNumber, HAIRLINE_WIDTH, pointsToSvg } from "./svg-utils"

const BRACE_INSET = 5
const CORNER = 5
const ENTRY_STEP = 10
const ENTRY_TEXT_INSET = 5
const LINE_WIDTHS = [HAIRLINE_WIDTH, 1, 3, 5]

const n = formatSvgNumber

// Renders every harness object in the Additional stream. Entries (216) and type labels (217) belong to
// the connector (215) before them; OWNERINDEX, when present, counts within the Additional list.
export function renderHarnessRecords(
  records: AltiumRecord[],
  viewport: SvgViewport,
  sheetRecord: AltiumSchSheetRecord | undefined,
): string {
  const out: string[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    const identity = `data-i="${ADDITIONAL_BASE + i}" data-k="${record.recordKind}"`
    if (record.recordKind === "218") out.push(`<g ${identity}>${renderHarnessWire(record, viewport)}</g>`)
    if (record.recordKind !== "215") continue
    const children = records.filter((child, j) => {
      if (child.recordKind !== "216" && child.recordKind !== "217") return false
      const owner = child.getNumber("OWNERINDEX")
      if (owner !== undefined) return owner === i
      // No OWNERINDEX: the child follows its connector directly.
      let k = j - 1
      while (k >= 0 && records[k]!.recordKind !== "215") k--
      return k === i
    })
    out.push(`<g ${identity}>${renderHarnessConnector(record, children, viewport, sheetRecord)}</g>`)
  }
  return out.join("")
}

function renderHarnessConnector(
  record: AltiumRecord,
  children: AltiumRecord[],
  viewport: SvgViewport,
  sheetRecord: AltiumSchSheetRecord | undefined,
): string {
  const left = getSchematicCoordinate(record, { key: "LOCATION.X" })
  const top = getSchematicCoordinate(record, { key: "LOCATION.Y" })
  const right = left + getSchematicCoordinate(record, { key: "XSIZE", fallback: 50 })
  const bottom = top - getSchematicCoordinate(record, { key: "YSIZE", fallback: 30 })
  const tipY = top - getSchematicCoordinate(record, { key: "PRIMARYCONNECTIONPOSITION", fallback: (top - bottom) / 2 })
  const inset = left + BRACE_INSET
  const P = (x: number, y: number) => `${n(viewport.toX(x))} ${n(viewport.toY(y))}`

  // Left side: rounded corners, then a brace pointing out at the primary connection.
  const brace =
    `M ${P(inset + CORNER, top)} Q ${P(inset, top)} ${P(inset, top - CORNER)} ` +
    `L ${P(inset, tipY + CORNER)} Q ${P(inset, tipY)} ${P(left, tipY)} ` +
    `Q ${P(inset, tipY)} ${P(inset, tipY - CORNER)} ` +
    `L ${P(inset, bottom + CORNER)} Q ${P(inset, bottom)} ${P(inset + CORNER, bottom)}`
  const outline = altiumColorToCss(record.getCaseInsensitive("COLOR"), "#8f9fc9")
  const width = LINE_WIDTHS[readSchematicInteger(record.getCaseInsensitive("LINEWIDTH"), 1)] ?? 1
  const parts = [
    `<path d="${brace} L ${P(right, bottom)} L ${P(right, top)} Z" fill="${altiumColorToCss(record.getCaseInsensitive("AREACOLOR"), "#edf2fb")}"/>`,
    `<path d="${brace}" fill="none" stroke="${outline}" stroke-width="${n(width)}"/>`,
  ]

  for (const child of children) {
    if (child.recordKind === "216") {
      const y = top - (child.getNumber("DISTANCEFROMTOP") ?? 0) * ENTRY_STEP
      const color = altiumColorToCss(child.getCaseInsensitive("COLOR"), "#003a70")
      const textColor = altiumColorToCss(child.getCaseInsensitive("TEXTCOLOR"), color)
      const font = getSchematicFont({ fontIdFieldName: "TEXTFONTID", record: child, sheetRecord })
      parts.push(
        `<circle cx="${n(viewport.toX(right))}" cy="${n(viewport.toY(y))}" r="1" fill="${color}"/>`,
        `<text x="${n(viewport.toX(right - ENTRY_TEXT_INSET))}" y="${n(viewport.toY(y))}" text-anchor="end" dominant-baseline="central" fill="${textColor}" ${font.attributes}>${escapeXml(child.getDecoded("NAME") ?? "")}</text>`,
      )
    } else {
      const x = getSchematicCoordinate(child, { key: "LOCATION.X" })
      const y = getSchematicCoordinate(child, { key: "LOCATION.Y" })
      const font = getSchematicFont({ record: child, sheetRecord })
      parts.push(
        `<text x="${n(viewport.toX(x))}" y="${n(viewport.toY(y))}" text-anchor="end" dominant-baseline="text-after-edge" fill="${altiumColorToCss(child.getCaseInsensitive("COLOR"), "#000080")}" ${font.attributes}>${escapeXml(child.getDecoded("TEXT") ?? "")}</text>`,
      )
    }
  }
  return `<g data-record="215">${parts.join("")}</g>`
}

function renderHarnessWire(record: AltiumRecord, viewport: SvgViewport): string {
  const points = getSchematicIndexedPoints(record)
  if (points.length < 2) return ""
  const color = altiumColorToCss(record.getCaseInsensitive("COLOR"), "#adbce7")
  const svgPoints = pointsToSvg(points, viewport)
  const ticks: string[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length === 0) continue
    const dir: SvgPoint = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
    const normal: SvgPoint = { x: -dir.y, y: dir.x }
    const at = (along: number, across: number): SvgPoint => ({
      x: viewport.toX(a.x + dir.x * along + normal.x * across),
      y: viewport.toY(a.y + dir.y * along + normal.y * across),
    })
    for (let d = 2; d + 3.9 <= length; d += 10) {
      const s = at(d, 1.7)
      const e = at(d + 3.9, -1.8)
      ticks.push(`<line x1="${n(s.x)}" y1="${n(s.y)}" x2="${n(e.x)}" y2="${n(e.y)}" stroke="${color}" stroke-width="1.5"/>`)
    }
  }
  return (
    `<g data-record="218">` +
    `<polyline points="${svgPoints}" fill="none" stroke="${lighten(color, 0x1e)}" stroke-width="5.1" stroke-linecap="round" stroke-linejoin="round"/>` +
    ticks.join("") +
    `<polyline points="${svgPoints}" fill="none" stroke="${color}" stroke-width="1"/>` +
    `</g>`
  )
}

function lighten(css: string, amount: number): string {
  const v = Number.parseInt(css.slice(1), 16)
  const c = (shift: number) => Math.min(255, ((v >> shift) & 0xff) + amount).toString(16).padStart(2, "0")
  return `#${c(16)}${c(8)}${c(0)}`
}
