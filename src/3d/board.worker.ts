// The 3D view's own worker: it parses the board again from its bytes and builds everything 3D from it
// (the stack and bodies, the layered geometry, the embedded STEP files, highlight geometry), so this
// heavy work never queues in front of the schematic and PCB views on the parse worker. The scene is
// built by the same code from the same bytes, so its object ids match the main scene's.
import { expose, transfer } from "comlink"
import { BufferAttribute, BufferGeometry } from "three"
import { MeshBVH } from "three-mesh-bvh"
import type { AltiumBinaryPcbDoc } from "altiumts"
import { parsePcb } from "../parse/extract-pcb"
import { buildPcbScene, type PcbScene } from "../pcb/scene"
import { extractBoard3d, stepBytes, type Board3d } from "./board3d"
import { buildBoardGeometry, buildHighlightGeometry, type GeoMesh } from "./board-geometry"
import { estimateStep, exportStep, type StepEstimate, type StepExportOptions } from "./step-export/export-step"
import type { StepQuality } from "./step-export/options"

let doc: AltiumBinaryPcbDoc | null = null
let scene: PcbScene | null = null
let board: Board3d | null = null
let models: Map<string, Uint8Array | null> | null = null // the embedded STEP files, read once asked for
const estimates = new Map<StepQuality, StepEstimate>()

const buffersOf = (meshes: GeoMesh[]) => meshes.flatMap(m => [m.positions.buffer, m.normals.buffer, m.index.buffer, ...(m.bvh?.roots ?? [])] as ArrayBuffer[])

// Each mesh's ray-test tree, built here rather than on the page (~1 s for Cubli). Building it reorders
// the triangles, so the mesh takes the tree's index.
function withBvh(m: GeoMesh): GeoMesh {
	const g = new BufferGeometry()
	g.setAttribute("position", new BufferAttribute(m.positions, 3))
	g.setIndex(new BufferAttribute(m.index, 1))
	const { index, ...tree } = MeshBVH.serialize(new MeshBVH(g), { cloneBuffers: false })
	return { ...m, index: index as Uint32Array, bvh: tree }
}

const api = {
	open(bytes: Uint8Array): Board3d {
		doc = parsePcb(bytes)
		scene = buildPcbScene(doc)
		board = extractBoard3d(doc)
		models = null
		estimates.clear()
		return board
	},
	geometry() {
		if (!scene || !board) throw new Error("No board open")
		const g = buildBoardGeometry(scene, board)
		g.meshes = g.meshes.map(withBvh)
		return transfer(g, buffersOf(g.meshes))
	},
	async stepModel(key: string) {
		const bytes = doc ? await stepBytes(doc, key) : null
		return bytes ? transfer(bytes, [bytes.buffer as ArrayBuffer]) : null
	},
	// The board as a STEP assembly (see exportStep), every embedded model read from the board.
	async exportStep(name: string, options: StepExportOptions) {
		if (!doc || !scene || !board) throw new Error("No board open")
		const r = exportStep(scene, board, await stepFiles(), name, options)
		return transfer(r, [r.bytes.buffer as ArrayBuffer])
	},
	// What each export setting adds to the file, at a quality (see estimateStep); the parts' share, the
	// same at every quality, measured once.
	async estimateStep(quality: StepQuality): Promise<StepEstimate> {
		if (!scene || !board) throw new Error("No board open")
		const known = estimates.get(quality)
		if (known) return known
		const e = estimateStep(scene, board, await stepFiles(), quality, estimates.values().next().value?.parts)
		estimates.set(quality, e)
		return e
	},
	highlight(ids: number[]) {
		const meshes = scene && board ? buildHighlightGeometry(scene, board, ids) : []
		return transfer(meshes, buffersOf(meshes))
	},
}
async function stepFiles() {
	if (!models) {
		const read = new Map<string, Uint8Array | null>()
		for (const m of board!.models) read.set(m.key, await stepBytes(doc!, m.key))
		models = read
	}
	return models
}

export type BoardWorkerApi = typeof api
expose(api)
