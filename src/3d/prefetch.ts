// Everything the 3D view needs, fetched once per compiled project and kept: the board scene, its 3D
// facts, the layered board geometry and every STEP model converted. Started in the background as soon
// as a project opens (no three.js here), so the 3D tab usually finds it all ready; the view shows its
// loading screen until it is, then shows the whole board at once. The heavy work runs in the 3D
// view's own worker (board.worker.ts), never in front of the schematic and PCB views.
import { wrap, type Remote } from "comlink"
import type { Parser } from "../parse/parser"
import type { ProjectData } from "../parse/project-data"
import type { PcbScene } from "../pcb/scene"
import { pcbScene } from "../pcb/use-scene"
import type { Board3d } from "./board3d"
import type { BoardGeometry, GeoMesh } from "./board-geometry"
import type { BoardWorkerApi } from "./board.worker"
import { fitBoxesToModels } from "./model-outline"
import { stepMesh, type StepMesh } from "./step-mesh"
import type { StepEstimate, StepExportOptions, StepExportResult } from "./step-export/export-step"
import type { StepQuality } from "./step-export/options"

export interface Loaded3d {
	scene: PcbScene
	board: Board3d
	geometry: BoardGeometry
	models: Map<string, StepMesh | null> // null: the file could not be converted
	highlight(ids: number[]): Promise<GeoMesh[]> // a selection's copper, as geometry
	exportStep(name: string, options: StepExportOptions): Promise<StepExportResult> // the board as a STEP assembly
	estimateStep(quality: StepQuality): Promise<StepEstimate> // what each export setting adds to the file
}

export interface Load3d {
	done: Promise<Loaded3d | null> // null: no board
	progress: { done: number; total: number } // models converted so far
}

// The open project, the commit compared with it, and the home screen's board preview (board-preview.ts).
export type Side = "primary" | "secondary" | "preview"

const loads = new WeakMap<ProjectData, Load3d>()
// One 3D worker per side: a newly opened project replaces the last one's; a compared commit (the
// secondary) has its own, so loading it doesn't end the primary's (whose highlights still need it).
const workers = new Map<string, { remote: Remote<BoardWorkerApi>; terminate(): void }>()

// The part that needs only the board file: opened in the 3D worker, its geometry built and its part
// models converted. Started as soon as the project opens (startBoard3d), alongside the schematic, not
// after its compile; load3d joins it once the project's data is in.
interface Board3dLoad {
	remote: Remote<BoardWorkerApi>
	board: Promise<Board3d>
	geometry: Promise<BoardGeometry>
	models: Promise<Map<string, StepMesh | null>>
	progress: { done: number; total: number }
}
const boards = new Map<string, { key: string; load: Board3dLoad }>() // per side

export function startBoard3d(key: string, readBoard: () => Promise<Uint8Array>, side: Side = "primary"): Board3dLoad {
	const known = boards.get(side)
	if (known?.key === key) return known.load
	workers.get(side)?.terminate()
	const w = new Worker(new URL("./board.worker.ts", import.meta.url), { type: "module" })
	const remote = wrap<BoardWorkerApi>(w)
	workers.set(side, { remote, terminate: () => w.terminate() })
	const progress = { done: 0, total: 0 }
	const board = readBoard().then(bytes => remote.open(bytes))
	const geometry = board.then(() => remote.geometry())
	const models = board.then(async b => {
		progress.total = b.models.length
		const out = new Map<string, StepMesh | null>()
		await Promise.all(
			b.models.map(async m => {
				const mesh = await remote
					.stepModel(m.key)
					.then(bytes => (bytes ? stepMesh(bytes) : null))
					.catch(() => null)
				out.set(m.key, mesh)
				progress.done++
			}),
		)
		return out
	})
	const load = { remote, board, geometry, models, progress }
	boards.set(side, { key, load })
	board.catch(() => boards.get(side)?.load === load && boards.delete(side))
	return load
}

export function load3d(parser: Parser, data: ProjectData, boardKey: string, readBoard: () => Promise<Uint8Array>, side: Side = "primary"): Load3d {
	let load = loads.get(data)
	if (load) return load
	const early = startBoard3d(boardKey, readBoard, side)
	const { remote, progress } = early
	const done = (async (): Promise<Loaded3d | null> => {
		const [scene, board] = await Promise.all([pcbScene(parser, data), early.board])
		if (!scene || !board) return null
		const [geometry, models] = await Promise.all([early.geometry, early.models])
		// The PCB view's part boxes, fitted to the models now that they are in (it redraws on view3dPrepared).
		fitBoxesToModels(scene, board, models)
		return { scene, board, geometry, models, highlight: ids => remote.highlight(ids), exportStep: (name, options) => remote.exportStep(name, options), estimateStep: quality => remote.estimateStep(quality) }
	})()
	load = { done, progress }
	done.catch(() => loads.delete(data))
	loads.set(data, load)
	return load
}
