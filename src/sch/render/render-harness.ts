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
    if (record.recordKind === "225") out.push(`<g ${identity}>${renderBlanket(record, viewport)}</g>`)
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

// A connector's frame. HARNESSCONNECTORSIDE is the side its brace (and primary connection) is on:
// 0 left, 1 right, 2 top, 3 bottom; the entries sit on the opposite edge. Positions along the brace edge
// (the primary connection, entries' DISTANCEFROMTOP x 10) count from the top, or from the left on a
// top/bottom connector. at(a, b) maps a position a along the brace edge, b in from it, to sheet units.
export interface HarnessConnectorFrame {
  side: number
  length: number // along the brace edge
  depth: number // brace edge to the entry edge
  tipAlong: number
  at(along: number, inward: number): SvgPoint
  tip: SvgPoint
  entryAt(distanceFromTop: number): SvgPoint
}

export function harnessConnectorFrame(record: AltiumRecord): HarnessConnectorFrame {
  const left = getSchematicCoordinate(record, { key: "LOCATION.X" })
  const top = getSchematicCoordinate(record, { key: "LOCATION.Y" })
  const width = getSchematicCoordinate(record, { key: "XSIZE", fallback: 50 })
  const height = getSchematicCoordinate(record, { key: "YSIZE", fallback: 30 })
  const side = Math.round(record.getNumber("HARNESSCONNECTORSIDE") ?? 0)
  const vertical = side === 2 || side === 3
  const length = vertical ? width : height
  const depth = vertical ? height : width
  const at = (a: number, b: number): SvgPoint => {
    if (side === 1) return { x: left + width - b, y: top - a }
    if (side === 2) return { x: left + a, y: top - b }
    if (side === 3) return { x: left + a, y: top - height + b }
    return { x: left + b, y: top - a }
  }
  const tipAlong = getSchematicCoordinate(record, { key: "PRIMARYCONNECTIONPOSITION", fallback: length / 2 })
  return {
    side,
    length,
    depth,
    tipAlong,
    at,
    tip: at(tipAlong, 0),
    entryAt: distance => at(distance * ENTRY_STEP, depth),
  }
}

function renderHarnessConnector(
  record: AltiumRecord,
  children: AltiumRecord[],
  viewport: SvgViewport,
  sheetRecord: AltiumSchSheetRecord | undefined,
): string {
  const frame = harnessConnectorFrame(record)
  const { length, depth, tipAlong } = frame
  const P = (a: number, b: number) => {
    const p = frame.at(a, b)
    return `${n(viewport.toX(p.x))} ${n(viewport.toY(p.y))}`
  }

  // The brace side: rounded corners, then a brace pointing out at the primary connection.
  const brace =
    `M ${P(0, BRACE_INSET + CORNER)} Q ${P(0, BRACE_INSET)} ${P(CORNER, BRACE_INSET)} ` +
    `L ${P(tipAlong - CORNER, BRACE_INSET)} Q ${P(tipAlong, BRACE_INSET)} ${P(tipAlong, 0)} ` +
    `Q ${P(tipAlong, BRACE_INSET)} ${P(tipAlong + CORNER, BRACE_INSET)} ` +
    `L ${P(length - CORNER, BRACE_INSET)} Q ${P(length, BRACE_INSET)} ${P(length, BRACE_INSET + CORNER)}`
  const outline = altiumColorToCss(record.getCaseInsensitive("COLOR"), "#8f9fc9")
  const width = LINE_WIDTHS[readSchematicInteger(record.getCaseInsensitive("LINEWIDTH"), 1)] ?? 1
  const parts = [
    `<path d="${brace} L ${P(length, depth)} L ${P(0, depth)} Z" fill="${altiumColorToCss(record.getCaseInsensitive("AREACOLOR"), "#edf2fb")}"/>`,
    `<path d="${brace}" fill="none" stroke="${outline}" stroke-width="${n(width)}"/>`,
  ]

  // Entry names read inward from the entry edge: right-aligned on a left-brace connector, left-aligned on
  // a right-brace one, turned upright on a top/bottom one.
  const anchor = frame.side === 1 || frame.side === 2 ? "start" : "end"
  for (const child of children) {
    if (child.recordKind === "216") {
      const distance = child.getNumber("DISTANCEFROMTOP") ?? 0
      const dot = frame.at(distance * ENTRY_STEP, depth)
      const label = frame.at(distance * ENTRY_STEP, depth - ENTRY_TEXT_INSET)
      const color = altiumColorToCss(child.getCaseInsensitive("COLOR"), "#003a70")
      const textColor = altiumColorToCss(child.getCaseInsensitive("TEXTCOLOR"), color)
      const font = getSchematicFont({ fontIdFieldName: "TEXTFONTID", record: child, sheetRecord })
      const lx = n(viewport.toX(label.x))
      const ly = n(viewport.toY(label.y))
      const turn = frame.side === 2 || frame.side === 3 ? ` transform="rotate(-90 ${lx} ${ly})"` : ""
      parts.push(
        `<circle cx="${n(viewport.toX(dot.x))}" cy="${n(viewport.toY(dot.y))}" r="1" fill="${color}"/>`,
        `<text x="${lx}" y="${ly}"${turn} text-anchor="${anchor}" dominant-baseline="central" fill="${textColor}" ${font.attributes}>${escapeXml(child.getDecoded("NAME") ?? "")}</text>`,
      )
    } else {
      // The type label: JUSTIFICATION 0-8 = bottom/middle/top rows of left/centre/right.
      const x = getSchematicCoordinate(child, { key: "LOCATION.X" })
      const y = getSchematicCoordinate(child, { key: "LOCATION.Y" })
      const justification = Math.min(Math.max(Math.round(child.getNumber("JUSTIFICATION") ?? 0), 0), 8)
      const textAnchor = ["start", "middle", "end"][justification % 3]
      const baseline = ["text-after-edge", "central", "text-before-edge"][Math.floor(justification / 3)]
      const font = getSchematicFont({ record: child, sheetRecord })
      parts.push(
        `<text x="${n(viewport.toX(x))}" y="${n(viewport.toY(y))}" text-anchor="${textAnchor}" dominant-baseline="${baseline}" fill="${altiumColorToCss(child.getCaseInsensitive("COLOR"), "#000080")}" ${font.attributes}>${escapeXml(child.getDecoded("TEXT") ?? "")}</text>`,
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

// Dash patterns (sheet units) by line style: 0 solid, 1 dashed, 2 dotted, 3 dash-dotted.
const DASHES = ["", "5 3", "1 2", "5 2 1 2"]

// A blanket: an outline whose directives (the parameter set on its edge) apply to every net inside.
// Drawn as its polygon, dashed by default, filled only when it is solid.
function renderBlanket(record: AltiumRecord, viewport: SvgViewport): string {
  const points = getSchematicIndexedPoints(record)
  if (points.length < 3) return ""
  const style = readSchematicInteger(record.getCaseInsensitive("LINESTYLEEXT") ?? record.getCaseInsensitive("LINESTYLE"), 1)
  const width = Math.max(1, LINE_WIDTHS[readSchematicInteger(record.getCaseInsensitive("LINEWIDTH"), 0)] ?? 1)
  const solid = record.getCaseInsensitive("ISSOLID") === "T"
  const dash = DASHES[style] ? ` stroke-dasharray="${DASHES[style]}"` : ""
  return (
    `<g data-record="225">` +
    `<polygon points="${pointsToSvg(points, viewport)}" fill="${solid ? altiumColorToCss(record.getCaseInsensitive("AREACOLOR"), "#ffffff") : "none"}"${solid ? ` fill-opacity="${record.getCaseInsensitive("TRANSPARENT") === "T" ? 0.5 : 1}"` : ""} stroke="${altiumColorToCss(record.getCaseInsensitive("COLOR"), "#ff0000")}" stroke-width="${n(width)}"${dash}/>` +
    `</g>`
  )
}

function lighten(css: string, amount: number): string {
  const v = Number.parseInt(css.slice(1), 16)
  const c = (shift: number) => Math.min(255, ((v >> shift) & 0xff) + amount).toString(16).padStart(2, "0")
  return `#${c(16)}${c(8)}${c(0)}`
}
