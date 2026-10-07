import { expose } from "comlink"
import { parseProjectFile, parseSheetLinks, renderSheetSvg } from "./altium"
import { buildProjectData, getPcbScene } from "./project-data"

const api = { parseProjectFile, parseSheetLinks, renderSheetSvg, buildProjectData, getPcbScene }
export type WorkerApi = typeof api

expose(api)
