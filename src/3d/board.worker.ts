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

let doc: AltiumBinaryPcbDoc | null = null
let scene: PcbScene | null = null
let board: Board3d | null = null

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
	highlight(ids: number[]) {
		const meshes = scene && board ? buildHighlightGeometry(scene, board, ids) : []
		return transfer(meshes, buffersOf(meshes))
	},
}
export type BoardWorkerApi = typeof api
expose(api)
