import {
	parseProjectFile,
	parseSheetLinks,
	renderSheetSvg,
	type ProjectFile,
	type SheetLink,
	type SheetRenderOptions,
} from "./altium"
import type { PcbScene } from "../pcb/scene"
import { buildProjectData, getPcbScene, type ProjectData, type ProjectDataInput } from "./project-data"

// What the app needs from the parser. Async so a Web Worker can implement it.
export interface Parser {
	parseProjectFile(bytes: Uint8Array): Promise<ProjectFile>
	parseSheetLinks(bytes: Uint8Array): Promise<SheetLink[]>
	renderSheetSvg(bytes: Uint8Array, options: SheetRenderOptions): Promise<string>
	buildProjectData(input: ProjectDataInput): Promise<ProjectData>
	// Needs buildProjectData to have run with a board.
	// The compiled project's board as drawable shapes; null without a board.
	getPcbScene(): Promise<PcbScene | null>
}

export const localParser: Parser = {
	parseProjectFile: async bytes => parseProjectFile(bytes),
	parseSheetLinks: async bytes => parseSheetLinks(bytes),
	renderSheetSvg: async (bytes, options) => renderSheetSvg(bytes, options),
	buildProjectData: async input => buildProjectData(input),
	getPcbScene: async () => getPcbScene(),
}
