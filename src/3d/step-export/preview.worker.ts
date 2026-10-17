// The export dialog's preview board, exported: its own worker, so a preview never waits behind the
// open board's work (its load, the size estimate's exports) in the 3D view's worker.
import { expose, transfer } from "comlink"
import type { PcbScene } from "../../pcb/scene"
import type { Board3d } from "../board3d"
import { exportStep, layerColours, type StepExportOptions } from "./export-step"
import { SAMPLE_MODELS, sampleBoard } from "./sample-board"

export interface StepPreviewFile {
	bytes: Uint8Array
	layers: Record<string, number[]> // part name -> colour as written
	models: Uint8Array[]
	// Where the vias' holes would be (mm, on the top copper's face), when they are left solid and their
	// copper shows (an untented via's always, a tented one's under the mask only with the copper under
	// it, or with no mask): the preview marks them dark, as a drilled hole looks, so the vias read as vias.
	viaMarks: { x: number; y: number; r: number; z: number }[]
}

const MM = 0.0254

// The preview board, and its two part models, fetched once.
let sample: Promise<{ scene: PcbScene; board: Board3d; models: Map<string, Uint8Array | null> }> | null = null
function previewBoard() {
	sample ??= (async () => {
		const models = new Map<string, Uint8Array | null>()
		for (const m of Object.values(SAMPLE_MODELS)) models.set(m.key, new Uint8Array(await (await fetch(m.url)).arrayBuffer()))
		return { ...sampleBoard(), models }
	})()
	return sample
}

const api = {
	// The preview board as the export writes it with these settings (see sampleBoard), with what reading
	// it back needs: its layers' colours and its part models.
	async previewStep(options: StepExportOptions): Promise<StepPreviewFile> {
		const { scene, board, models } = await previewBoard()
		const { bytes } = exportStep(scene, board, models, "Preview", options)
		const shows = (tented: boolean) => !options.viaHoles && options.copper && (!options.mask || !tented || options.copperUnderMask)
		// The copper's face: under the mask at its height in the stack, else just above the board (as exportStep).
		const topCopper = board.stack.find(l => l.kind === "copper")?.top ?? 0
		const z = (options.mask ? (board.thickness - topCopper) * MM : board.thickness * MM + 0.012) + 0.004
		const viaMarks = scene.objects
			.filter(o => o.kind === "via" && shows(o.mask?.top === null))
			.flatMap(o => o.holes.flatMap(h => (h.t === "circle" ? [{ x: (h.x - scene.origin[0]) * MM, y: (h.y - scene.origin[1]) * MM, r: h.r * MM, z }] : [])))
		const file = { bytes, layers: layerColours(board.colors), models: [...models.values()].filter((m): m is Uint8Array => m !== null), viaMarks }
		return transfer(file, [bytes.buffer as ArrayBuffer])
	},
}
export type PreviewWorkerApi = typeof api
expose(api)
