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

export interface Loaded3d {
	scene: PcbScene
	board: Board3d
	geometry: BoardGeometry
	models: Map<string, StepMesh | null> // null: the file could not be converted
	highlight(ids: number[]): Promise<GeoMesh[]> // a selection's copper, as geometry
}

export interface Load3d {
	done: Promise<Loaded3d | null> // null: no board
	progress: { done: number; total: number } // models converted so far
}

const loads = new WeakMap<ProjectData, Load3d>()
// One 3D worker per side: a newly opened project replaces the last one's; a compared commit (the
// secondary) has its own, so loading it doesn't end the primary's (whose highlights still need it).
const workers = new Map<string, { remote: Remote<BoardWorkerApi>; terminate(): void }>()

export function load3d(parser: Parser, data: ProjectData, readBoard: () => Promise<Uint8Array>, side: "primary" | "secondary" = "primary"): Load3d {
	let load = loads.get(data)
	if (load) return load
	const progress = { done: 0, total: 0 }
	workers.get(side)?.terminate()
	const w = new Worker(new URL("./board.worker.ts", import.meta.url), { type: "module" })
	const remote = wrap<BoardWorkerApi>(w)
	workers.set(side, { remote, terminate: () => w.terminate() })
	const done = (async (): Promise<Loaded3d | null> => {
		const [scene, board] = await Promise.all([pcbScene(parser, data), readBoard().then(bytes => remote.open(bytes))])
		if (!scene || !board) return null
		progress.total = board.models.length
		const models = new Map<string, StepMesh | null>()
		const modelsDone = Promise.all(
			board.models.map(async m => {
				const mesh = await remote
					.stepModel(m.key)
					.then(bytes => (bytes ? stepMesh(bytes) : null))
					.catch(() => null)
				models.set(m.key, mesh)
				progress.done++
			}),
		)
		const geometry = await remote.geometry()
		await modelsDone
		// The PCB view's part boxes, fitted to the models now that they are in (it redraws on view3dPrepared).
		fitBoxesToModels(scene, board, models)
		return { scene, board, geometry, models, highlight: ids => remote.highlight(ids) }
	})()
	load = { done, progress }
	done.catch(() => loads.delete(data))
	loads.set(data, load)
	return load
}
