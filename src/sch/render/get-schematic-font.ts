import type { AltiumRecord } from "altiumts"
import type { AltiumSchSheetRecord } from "altiumts"
import { readSchematicInteger } from "./altium-values"
import { escapeXml, formatSvgNumber } from "./svg-utils"

const DEFAULT_SCHEMATIC_FONT_ID = 0
const DEFAULT_SCHEMATIC_FONT_SIZE = 10
const DEFAULT_SCHEMATIC_FONT_FAMILY = "Times New Roman"
const PIN_CUSTOM_FONT_ID_FLAG = 0x10

type GetSchematicFontInput = {
  fontIdFieldName?: string
  inheritSystemFont?: boolean
  pinText?: "NAME" | "DESIGNATOR"
  record: AltiumRecord
  sheetRecord: AltiumSchSheetRecord | undefined
}

export type SchematicFont = {
  attributes: string
  family: string
  size: number
}

// (winAscent + winDescent) / unitsPerEm. Times New Roman and Consolas have fitted metrics.
const CELL_HEIGHT_RATIOS: Record<string, number> = {
  "times new roman": 1.121,
  consolas: 1.17,
  arial: 1.117,
  "courier new": 1.133,
  calibri: 1.221,
  "segoe ui": 1.33,
  tahoma: 1.207,
  verdana: 1.215,
}

function cellHeightRatio(family: string): number {
  return CELL_HEIGHT_RATIOS[family.trim().toLowerCase()] ?? 1.15
}

export function getSchematicFont({
  fontIdFieldName = "FONTID",
  inheritSystemFont = true,
  pinText,
  record,
  sheetRecord,
}: GetSchematicFontInput): SchematicFont {
  const systemFontId = inheritSystemFont
    ? readSchematicInteger(
        sheetRecord?.getCaseInsensitive("SYSTEMFONT"),
        DEFAULT_SCHEMATIC_FONT_ID,
      )
    : DEFAULT_SCHEMATIC_FONT_ID
  // Pin name and number each have an independent custom-font flag and ID.
  // Older pin records instead store their shared font in FONTID.
  const hasCustomPinFont = pinText
    ? (readSchematicInteger(
        record.getCaseInsensitive(`PIN${pinText}_POSITIONCONGLOMERATE`),
        0,
      ) &
        PIN_CUSTOM_FONT_ID_FLAG) !==
      0
    : false
  const recordFontId = readSchematicInteger(
    record.getCaseInsensitive("FONTID"),
    systemFontId,
  )
  const isLegacyPinRecord =
    record.getCaseInsensitive("PINNAME_POSITIONCONGLOMERATE") === undefined &&
    record.getCaseInsensitive("PINDESIGNATOR_POSITIONCONGLOMERATE") ===
      undefined
  const legacyFontIsDefined =
    sheetRecord?.getCaseInsensitive(`SIZE${recordFontId}`) !== undefined
  const legacyPinFontId =
    pinText && isLegacyPinRecord && legacyFontIsDefined
      ? recordFontId
      : systemFontId

  let requestedFontId = readSchematicInteger(
    record.getCaseInsensitive(fontIdFieldName),
    systemFontId,
  )
  if (pinText) {
    requestedFontId = hasCustomPinFont
      ? readSchematicInteger(
          record.getCaseInsensitive(`${pinText}_CUSTOMFONTID`),
          systemFontId,
        )
      : legacyPinFontId
  }
  // A missing system font uses Altium's Times New Roman 10 default. An
  // invalid SIZE token falls back to 10, retaining the selected family.
  const fontId = requestedFontId > 0 ? requestedFontId : systemFontId
  // SIZE is a native integer font-table entry, not a coordinate.
  // In particular, SIZE*_FRAC does not increase the native font size.
  const selectedSize = sheetRecord
    ? readSchematicInteger(
        sheetRecord.getCaseInsensitive(`SIZE${fontId}`),
        DEFAULT_SCHEMATIC_FONT_SIZE,
      )
    : DEFAULT_SCHEMATIC_FONT_SIZE
  const family =
    sheetRecord?.getDecoded(`FONTNAME${fontId}`) ??
    DEFAULT_SCHEMATIC_FONT_FAMILY
  // Altium's font size is the Windows cell height (ascent + descent), not the em.
  const size =
    (selectedSize > 0 ? selectedSize : DEFAULT_SCHEMATIC_FONT_SIZE) /
    cellHeightRatio(family)
  const weight =
    sheetRecord?.getBoolean(`BOLD${fontId}`) === true ? "bold" : "normal"
  const style =
    sheetRecord?.getBoolean(`ITALIC${fontId}`) === true ? "italic" : "normal"
  const decoration =
    sheetRecord?.getBoolean(`UNDERLINE${fontId}`) === true
      ? "underline"
      : "none"
  return {
    attributes: `font-family="${escapeXml(family)}" font-size="${formatSvgNumber(size)}" font-style="${style}" font-weight="${weight}" text-decoration="${decoration}"`,
    family,
    size,
  }
}
