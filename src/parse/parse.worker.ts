import { expose } from "comlink"
import { parseProjectFile, parseSheetLinks, renderSheetSvg } from "./altium"
import { buildProjectData, getPcbScene, renderFootprintSvg } from "./project-data"

const api = { parseProjectFile, parseSheetLinks, renderSheetSvg, buildProjectData, renderFootprintSvg, getPcbScene }
export type WorkerApi = typeof api

expose(api)
