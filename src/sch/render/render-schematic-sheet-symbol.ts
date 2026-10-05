// Vendored from altiumts v0.0.87 (MIT, (c) tscircuit Inc. — see LICENSE.altiumts), then extended:
// symbol/entry colours from the records, REPEAT stacks, and "Block & Triangle" entry shapes per I/O type.
import type { AltiumRecord } from "altiumts"
import { altiumColorToCss, getSchematicCoordinate } from "./altium-values"
import { getSchematicFont } from "./get-schematic-font"
import { renderAltiumNegatedText } from "./render-altium-negated-text"
import type { SchematicRenderContext } from "./schematic-render-context"
import type { SvgPoint, SvgViewport } from "./svg-types"
import { formatSvgNumber, getSvgHairlineWidth } from "./svg-utils"

type Side = 0 | 1 | 2 | 3 // left, right, top, bottom

type RenderSchematicSheetSymbolInput = {
  context: SchematicRenderContext
  metadata: string
  record: AltiumRecord
  viewport: SvgViewport
}

const ENTRY_STEP = 10 // DISTANCEFROMTOP is in 10-unit steps
const ENTRY_TEXT_INSET = 20
const REPEAT_STACK_OFFSET = 2
const HARNESS_ENTRY_FILL = "#d5e4ff"
const HARNESS_ENTRY_STROKE = "#71809b"

// Entry outlines in local coordinates: u runs from the sheet edge (0) inwards, v across the entry.
const ENTRY_SHAPES: Record<number, ReadonlyArray<readonly [number, number]>> = {
  0: [[0, 4], [15, 4], [15, -4], [0, -4]], // unspecified
  1: [[0, 0], [4.1, 4], [15, 4], [15, -4], [4.1, -4]], // output: tip at the edge
  2: [[0, 4], [10.9, 4], [15, 0], [10.9, -4], [0, -4]], // input: tip pointing into the sheet
  3: [[0, 0], [4, 4], [11, 4], [15, 0], [11, -4], [4, -4]], // bidirectional
}

export function renderSchematicSheetSymbol({
  context,
  metadata,
  record,
  viewport,
}: RenderSchematicSheetSymbolInput): string {
  const { x, y } = getSchematicLocation(record)
  const width = Math.max(getSchematicCoordinate(record, { key: "XSIZE", fallback: 1 }), 1)
  const height = Math.max(getSchematicCoordinate(record, { key: "YSIZE", fallback: 1 }), 1)
  const fill =
    record.getBoolean("ISSOLID") === false
      ? "none"
      : altiumColorToCss(record.getCaseInsensitive("AREACOLOR"), "#ffffc2")
  const stroke = altiumColorToCss(record.getCaseInsensitive("COLOR"), "#800000")
  const strokeWidth = formatSvgNumber(getSvgHairlineWidth(viewport))
  const rect = (dx: number) =>
    `<rect ${metadata} x="${formatSvgNumber(viewport.toX(x + dx))}" y="${formatSvgNumber(viewport.toY(y - dx))}" width="${formatSvgNumber(width)}" height="${formatSvgNumber(height)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`

  // A repeated (multi-channel) sheet symbol is drawn as a stack, back to front.
  const repeated = /^\s*repeat\s*\(/i.test(getSheetSymbolDesignator(context, record) ?? "")
  const layers = repeated ? [2 * REPEAT_STACK_OFFSET, REPEAT_STACK_OFFSET, 0] : [0]
  return layers.map(rect).join("")
}

export function renderSchematicSheetEntry({
  context,
  metadata,
  record,
  viewport,
}: RenderSchematicSheetSymbolInput): string | undefined {
  const sheetSymbol = getSchematicRecordParent(context, record)
  if (sheetSymbol?.recordKind !== "15") return undefined

  const origin = getSchematicLocation(sheetSymbol)
  const width = Math.max(getSchematicCoordinate(sheetSymbol, { key: "XSIZE", fallback: 1 }), 1)
  const height = Math.max(getSchematicCoordinate(sheetSymbol, { key: "YSIZE", fallback: 1 }), 1)
  const side = getSide(record)
  const offset = Math.max(record.getNumber("DISTANCEFROMTOP") ?? 0, 0) * ENTRY_STEP

  // Edge point of the entry, and the inward (u) / across (v) directions in Altium coordinates.
  const frames: Record<Side, { edge: SvgPoint; u: SvgPoint; v: SvgPoint }> = {
    0: { edge: { x: origin.x, y: origin.y - offset }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 } },
    1: { edge: { x: origin.x + width, y: origin.y - offset }, u: { x: -1, y: 0 }, v: { x: 0, y: 1 } },
    2: { edge: { x: origin.x + offset, y: origin.y }, u: { x: 0, y: -1 }, v: { x: 1, y: 0 } },
    3: { edge: { x: origin.x + offset, y: origin.y - height }, u: { x: 0, y: 1 }, v: { x: 1, y: 0 } },
  }
  const { edge, u, v } = frames[side]
  const at = (du: number, dv: number) => ({
    x: viewport.toX(edge.x + u.x * du + v.x * dv),
    y: viewport.toY(edge.y + u.y * du + v.y * dv),
  })

  const isHarness = Boolean(record.getDecoded("HARNESSTYPE"))
  const ioType = isHarness ? 3 : Math.round(record.getNumber("IOTYPE") ?? 0)
  const shape = ENTRY_SHAPES[ioType] ?? ENTRY_SHAPES[0]!
  const points = shape
    .map(([du, dv]) => at(du, dv))
    .map(p => `${formatSvgNumber(p.x)},${formatSvgNumber(p.y)}`)
    .join(" ")
  const fill = isHarness
    ? HARNESS_ENTRY_FILL
    : altiumColorToCss(record.getCaseInsensitive("AREACOLOR"), "#ffff80")
  const stroke = isHarness
    ? HARNESS_ENTRY_STROKE
    : altiumColorToCss(record.getCaseInsensitive("COLOR"), "#800000")
  const textColor = altiumColorToCss(record.getCaseInsensitive("TEXTCOLOR"), "#800000")

  const name = record.getDecoded("NAME") ?? ""
  const font = getSchematicFont({
    fontIdFieldName: "TEXTFONTID",
    record,
    sheetRecord: context.sheetRecord,
  })
  const anchor = at(ENTRY_TEXT_INSET, 0)
  // Top/bottom entries read along the edge, rotated.
  const rotate =
    side === 2 || side === 3
      ? ` transform="rotate(-90 ${formatSvgNumber(anchor.x)} ${formatSvgNumber(anchor.y)})"`
      : ""
  const textAnchor = side === 1 || side === 2 ? "end" : "start"
  const text = name
    ? `<text x="${formatSvgNumber(anchor.x)}" y="${formatSvgNumber(anchor.y)}" text-anchor="${textAnchor}" dominant-baseline="central" fill="${textColor}" ${font.attributes}${rotate}>${renderAltiumNegatedText(name)}</text>`
    : ""
  return `<g ${metadata}><polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${formatSvgNumber(getSvgHairlineWidth(viewport))}"/>${text}</g>`
}

function getSheetSymbolDesignator(
  context: SchematicRenderContext,
  symbol: AltiumRecord,
): string | undefined {
  const children = context.document
    ? context.document.getOwnedRecords(symbol)
    : context.records.filter(r => getSchematicRecordParent(context, r) === symbol)
  return children.find(r => r.recordKind === "32")?.getDecoded("TEXT")
}

function getSchematicRecordParent(
  context: SchematicRenderContext,
  record: AltiumRecord,
): AltiumRecord | undefined {
  if (context.document) return context.document.getParent(record)
  const ownerIndex = record.getNumber("OWNERINDEX")
  return ownerIndex === undefined || ownerIndex < 0 ? undefined : context.records[ownerIndex]
}

function getSide(record: AltiumRecord): Side {
  const side = Math.round(record.getNumber("SIDE") ?? 0)
  return side === 1 || side === 2 || side === 3 ? side : 0
}

function getSchematicLocation(record: AltiumRecord): SvgPoint {
  return {
    x: getSchematicCoordinate(record, { key: "LOCATION.X" }),
    y: getSchematicCoordinate(record, { key: "LOCATION.Y" }),
  }
}
