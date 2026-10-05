// Everything the interactive views need beyond the drawings: each sheet's objects, the compiled
// project (nets across sheet instances and channels, components) and the board's data. Runs in the
// parse worker; the result is plain, structured-clone-able data.
import { compileProject, type CompiledProject, type CompileInstance } from "../model/compile"
import type { SheetData } from "../model/schematic-data"
import { decodeText, parseAdditionalRecords, parseNetColors, parseSchDoc } from "./altium"
import { serializeAltiumPcbToSvg, type AltiumBinaryPcbDoc } from "altiumts"
import { extractPcb, parsePcb, type PcbData } from "./extract-pcb"
import { extractSheet } from "./extract-sheet"
import { buildPcbScene, type PcbScene } from "../pcb/scene"
import { netSummaries } from "../pcb/nets"

export interface ProjectDataInput {
	instances: CompileInstance[]
	designatorFormat: string
	sheets: [docPath: string, bytes: Uint8Array][]
	pcb: Uint8Array | null
	project?: Uint8Array | null // the .PrjPcb, for net colours
}

export interface ProjectData {
	compiled: CompiledProject
	sheets: Record<string, SheetData>
	pcb: PcbData | null
	errors: string[] // documents that could not be read; the rest still compile
	// Schematic net colours (set in the project) applied to whole compiled nets: instance id -> wire
	// record index -> colour. A colour set on any of a net's names (12V) reaches the net under every
	// other name it has on lower sheets (V_GATE_DRIVE).
	wireColors: Record<string, Record<number, string>>
}

// The last compiled project's board, kept parsed for footprint pictures.
let board: AltiumBinaryPcbDoc | null = null
let scene: PcbScene | null = null

export function buildProjectData(input: ProjectDataInput): ProjectData {
	const errors: string[] = []
	const sheets = new Map<string, SheetData>()
	for (const [path, bytes] of input.sheets) {
		try {
			sheets.set(path, extractSheet(parseSchDoc(bytes), parseAdditionalRecords(bytes)))
		} catch (e) {
			errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
	let pcb: PcbData | null = null
	board = null
	scene = null
	if (input.pcb) {
		try {
			board = parsePcb(input.pcb)
			pcb = extractPcb(board)
			// Net lengths and layers need the board as shapes (pours, via spans): build the scene now.
			scene = buildPcbScene(board)
			pcb = { ...pcb, nets: netSummaries(scene), layers: scene.layers.filter(l => l.group === "copper").map(l => ({ key: l.key, name: l.name, color: l.color })) }
		} catch (e) {
			errors.push(`PCB: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
	const compiled = compileProject({
		instances: input.instances.filter(i => sheets.has(i.docPath)),
		sheets,
		designatorFormat: input.designatorFormat,
		padNets: pcb ? new Map(pcb.padNets) : undefined,
	})
	return { compiled, sheets: Object.fromEntries(sheets), pcb, errors, wireColors: wireColors(input, compiled, sheets) }
}

// A picture of one placed component's footprint (pads, copper, overlay), found by its source path.
export function renderFootprintSvg(sourceUniqueId: string): string | null {
	const doc = board as (AltiumBinaryPcbDoc & { components: { sourceUniqueId?: string }[] }) | null
	const index = doc?.components.findIndex(c => c.sourceUniqueId === sourceUniqueId) ?? -1
	if (!doc || index < 0) return null
	return serializeAltiumPcbToSvg(doc, { componentIndices: [index], fitToContent: true, showBoardOutline: false, width: 272, backgroundColor: "#000000" })
}

// The board as drawable shapes, built on first request (the PCB view) and kept.
export function getPcbScene(): PcbScene | null {
	if (!board) return null
	scene ??= buildPcbScene(board)
	return scene
}

function wireColors(input: ProjectDataInput, compiled: CompiledProject, sheets: Map<string, SheetData>): ProjectData["wireColors"] {
	const out: ProjectData["wireColors"] = {}
	if (!input.project) return out
	const colors = parseNetColors(decodeText(input.project))
	if (Object.keys(colors).length === 0) return out
	const docOf = new Map(input.instances.map(i => [i.id, i.docPath]))
	const wiresOf = new Map<string, Set<number>>()
	for (const [path, sheet] of sheets) wiresOf.set(path, new Set(sheet.objects.filter(o => o.kind === "wire").map(o => o.i)))
	for (const net of compiled.nets) {
		const name = [net.netName, net.physicalName, ...net.names].find(n => colors[n.toLowerCase()] !== undefined)
		if (!name) continue
		const color = colors[name.toLowerCase()]!
		for (const occ of net.occurrences) {
			const wires = wiresOf.get(docOf.get(occ.instanceId) ?? "")
			if (!wires) continue
			const map = (out[occ.instanceId] ??= {})
			for (const i of occ.objects) if (wires.has(i)) map[i] = color
		}
	}
	return out
}
