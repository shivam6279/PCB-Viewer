import { wrap, type Remote } from "comlink"
import type { Parser } from "./parser"
import type { WorkerApi } from "./parse.worker"

let remote: Remote<WorkerApi> | null = null

function api(): Remote<WorkerApi> {
	remote ??= wrap<WorkerApi>(new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" }))
	return remote
}

// A parser on a worker of its own, for a second project held at the same time (the worker keeps one
// project's compiled state). dispose() ends the worker.
export function separateWorkerParser(): Parser & { dispose(): void } {
	const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" })
	const own = wrap<WorkerApi>(worker)
	return {
		parseProjectFile: bytes => own.parseProjectFile(bytes),
		parseSheetLinks: bytes => own.parseSheetLinks(bytes),
		renderSheetSvg: (bytes, options) => own.renderSheetSvg(bytes, options),
		buildProjectData: input => own.buildProjectData(input),
		renderFootprintSvg: id => own.renderFootprintSvg(id),
		getPcbScene: () => own.getPcbScene(),
		dispose: () => worker.terminate(),
	}
}

export function workerParser(): Parser {
	return {
		parseProjectFile: bytes => api().parseProjectFile(bytes),
		parseSheetLinks: bytes => api().parseSheetLinks(bytes),
		renderSheetSvg: (bytes, options) => api().renderSheetSvg(bytes, options),
		buildProjectData: input => api().buildProjectData(input),
		renderFootprintSvg: id => api().renderFootprintSvg(id),
		getPcbScene: () => api().getPcbScene(),
	}
}
