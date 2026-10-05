import type { AltiumSchDoc } from "altiumts"
import type { AltiumRecord } from "altiumts"
import type { AltiumSchSheetRecord } from "altiumts"
import type { SchematicConnectionSegment } from "./get-schematic-port-direction"

export interface SchematicRenderContext {
  document?: AltiumSchDoc
  records: AltiumRecord[]
  portConnectionSegments?: SchematicConnectionSegment[]
  sheetRecord?: AltiumSchSheetRecord
}
