import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join, relative, sep } from "node:path"
import { describe, expect, test } from "vitest"
import { CORPUS, hasCorpus } from "./env"
import { projectData } from "./project-data"
import { NodeDirSource } from "../node-dir-source"
import { loadProject } from "../../src/model/load-project"
import { compileInstances, compileProject, netNamingOf, netScopeOf } from "../../src/model/compile"
import { localParser } from "../../src/parse/parser"
import { extractSheet } from "../../src/parse/extract-sheet"
import { extractPcb } from "../../src/parse/extract-pcb"
import { parseAdditionalRecords, parseProjectFile, parseSchDoc } from "../../src/parse/altium"
import type { SheetData } from "../../src/model/schematic-data"

// Oracle: the PCB was synchronised from the schematic by Altium, so every schematic pin's compiled
// net must be the PCB net of the matching pad (designator + pad name).
async function compileCubli(withPcbNames: boolean) {
	const dir = join(CORPUS, "Cubli/Main Board/STM32")
	const src = new NodeDirSource(dir)
	const project = await loadProject(src, "Cubli.PrjPcb", localParser)
	const sheets = new Map<string, SheetData>()
	for (const d of project.documents) {
		if (d.kind !== "sch" || !d.exists) continue
		const bytes = new Uint8Array(readFileSync(join(dir, d.path)))
		sheets.set(d.path, extractSheet(parseSchDoc(bytes), parseAdditionalRecords(bytes)))
	}
	const pcb = extractPcb(new Uint8Array(readFileSync(join(dir, "Cubli.PcbDoc"))))
	const compiled = compileProject({
		instances: compileInstances(project.hierarchy),
		sheets,
		designatorFormat: parseProjectFile(new Uint8Array(readFileSync(join(dir, "Cubli.PrjPcb")))).channelDesignatorFormat,
		padNets: withPcbNames ? new Map(pcb.padNets) : undefined,
	})
	return { compiled, pcb }
}

describe.skipIf(!hasCorpus)("project net compile on Cubli, checked against its PCB", () => {
	test("pins on one compiled net are exactly the pads on one PCB net", async () => {
		const { compiled, pcb } = await compileCubli(true)
		const padNet = new Map(pcb.padNets)
		const pcbGroups = new Map<string, Set<string>>()
		for (const [pad, net] of pcb.padNets) (pcbGroups.get(net) ?? pcbGroups.set(net, new Set()).get(net)!).add(pad)
		const problems: string[] = []
		for (const net of compiled.nets) {
			const pads = net.pins.map(p => `${p.path}|${p.pin}`).filter(p => padNet.has(p))
			const pcbNets = new Set(pads.map(p => padNet.get(p)))
			if (pcbNets.size > 1) problems.push(`${net.netName}: pins span PCB nets ${[...pcbNets].join(", ")}`)
		}
		for (const [pcbNet, pads] of pcbGroups) {
			const compiledNets = new Set([...pads].map(p => compiled.nets.find(n => n.pins.some(q => `${q.path}|${q.pin}` === p))?.netName ?? "<no pin>"))
			if (compiledNets.size > 1) problems.push(`PCB ${pcbNet}: pads split across ${[...compiledNets].join(", ")}`)
		}
		expect(problems).toEqual([])
	})

	test("names computed from the schematic alone match the PCB's net names", async () => {
		const { compiled, pcb } = await compileCubli(false)
		const padNet = new Map(pcb.padNets)
		const wrong: string[] = []
		for (const net of compiled.nets) {
			const pad = net.pins.map(p => `${p.path}|${p.pin}`).find(p => padNet.has(p))
			if (pad && padNet.get(pad) !== net.physicalName) wrong.push(`${net.physicalName} != PCB ${padNet.get(pad)}`)
		}
		expect(wrong).toEqual([])
	})
})

// Every corpus project with a board: no PCB net split across compiled nets, no compiled net spanning
// PCB nets. Known differences, each checked by hand:
const KNOWN: Record<string, string[]> = {
	// The board was made from an earlier, flat version of the design (its parts' source ids are not the
	// schematics').
	"LedFlex/LedFlex.PrjPcb": ["*"],
	// Half_bridge_drivers: the OUT wire crosses the Q1/Q2 wire with no junction, so the schematic does
	// not join them; the board (older) does.
	"Cubli/MotorBoard/Rev2/MotorBoard.PrjPcb": ["SPLIT Bridge_Out1", "SPLIT Bridge_Out2", "SPLIT Bridge_Out3"],
}

function corpusProjects(dir = CORPUS, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) {
			if (!/^(history|\.|project (logs|outputs) for |__previews)/i.test(name)) corpusProjects(p, out)
		} else if (/\.prjpcb$/i.test(name)) out.push(p)
	}
	return out
}

describe.skipIf(!hasCorpus)("project net compile on every corpus board, checked against its PCB", () => {
	test("pins on one compiled net are the pads of one PCB net", async () => {
		const problems: string[] = []
		for (const prj of corpusProjects()) {
			const rel = relative(CORPUS, prj).split(sep).join("/")
			const known = KNOWN[rel] ?? []
			if (known.includes("*")) continue
			const { compiled, pcb } = await projectData(dirname(prj), basename(prj))
			if (!pcb) continue
			const padNet = new Map(pcb.padNets)
			const pinNet = new Map<string, number>()
			for (const n of compiled.nets) for (const p of n.pins) pinNet.set(`${p.path}|${p.pin}`, n.id)
			for (const n of compiled.nets) {
				const pcbNets = new Set(n.pins.map(p => padNet.get(`${p.path}|${p.pin}`)).filter(Boolean))
				if (pcbNets.size > 1 && !known.includes(`MERGE ${n.netName}`)) problems.push(`${rel}: ${n.netName} spans PCB ${[...pcbNets].join(", ")}`)
			}
			const groups = new Map<string, string[]>()
			for (const [pad, net] of padNet) (groups.get(net) ?? groups.set(net, []).get(net)!).push(pad)
			for (const [net, pads] of groups) {
				const ids = new Set(pads.map(p => pinNet.get(p)).filter(id => id !== undefined))
				if (ids.size > 1 && !known.includes(`SPLIT ${net}`)) problems.push(`${rel}: PCB ${net} split across ${[...ids].map(id => compiled.nets[id]!.netName).join(", ")}`)
			}
		}
		expect(problems).toEqual([])
	}, 600000)
})

// Physical net names from the schematics alone (no board names), compared without case: a board keeps
// a net's old capitalisation when only the case changes. Known differences, each checked by hand:
const KNOWN_NAMES: Record<string, string[]> = {
	"LedFlex/LedFlex.PrjPcb": ["*"], // board from an earlier version of the design
	// The crossing without a junction (see KNOWN above): the schematic leaves these unnamed.
	"Cubli/MotorBoard/Rev2/MotorBoard.PrjPcb": ["Bridge_Out1", "Bridge_Out2", "Bridge_Out3"],
	// Sheet symbols with equal designators (unannotated copies): their channel order is not in the files.
	"Raise Robotics/PDB_Compute/PDB_Compute.PrjPcb": ["ISNS_OUT_R_2", "ISNS_OUT_R_3"],
	"Raise Robotics/PDB_Main/PDB_Main.PrjPcb": [
		"ON_OFF_LOW_1", "ON_OFF_LOW_2", "ON_OFF_HIGH_1", "ON_OFF_HIGH_2",
		...[1, 2, 3, 4].flatMap(k => [`ISNS_LG_OUT_R_${k}`, `ISNS_XL_VOC_${k}`, `ISNS_XL_OUT_R_${k}`]),
	],
	// Two ports compete (LINAC_DIR1 on the parent, LIN_AC_DIRECTION in each channel) and the board took
	// the channel's, against what decides every other net here.
	"Raise Robotics/RAISE_SENSOR_ACTUATOR_V3/RAISE_SENSOR_ACTUATOR_V3.PrjPcb": [1, 2, 3, 4].map(k => `LIN_AC_DIRECTION_${k}`),
}

describe.skipIf(!hasCorpus)("net names from the schematics alone, on every corpus board", () => {
	test("each net's physical name is its board net's name", async () => {
		const wrong: string[] = []
		for (const prj of corpusProjects()) {
			const rel = relative(CORPUS, prj).split(sep).join("/")
			const known = KNOWN_NAMES[rel] ?? []
			if (known.includes("*")) continue
			const dir = dirname(prj)
			const project = await loadProject(new NodeDirSource(dir), basename(prj), localParser)
			const pcbDoc = project.documents.find(d => d.kind === "pcb" && d.exists)
			if (!pcbDoc) continue
			const sheets = new Map<string, SheetData>()
			for (const d of project.documents) {
				if (d.kind !== "sch" || !d.exists) continue
				const bytes = new Uint8Array(readFileSync(join(dir, d.path)))
				sheets.set(d.path, extractSheet(parseSchDoc(bytes), parseAdditionalRecords(bytes)))
			}
			const text = readFileSync(prj, "latin1")
			const pcb = extractPcb(new Uint8Array(readFileSync(join(dir, pcbDoc.path))))
			const compiled = compileProject({
				instances: compileInstances(project.hierarchy).filter(i => sheets.has(i.docPath)),
				sheets,
				designatorFormat: project.channelDesignatorFormat,
				netScope: netScopeOf(text),
				naming: netNamingOf(text),
				boardDesignators: new Map(pcb.components.filter(c => c.sourceUniqueId && c.designator).map(c => [c.sourceUniqueId!, c.designator])),
			})
			const padNet = new Map(pcb.padNets)
			for (const net of compiled.nets) {
				const pad = net.pins.map(p => `${p.path}|${p.pin}`).find(p => padNet.has(p))
				const board = pad && padNet.get(pad)
				if (board && board.toUpperCase() !== net.physicalName.toUpperCase() && !known.includes(board)) wrong.push(`${rel}: ${net.physicalName} != board ${board}`)
			}
		}
		expect(wrong).toEqual([])
	}, 600000)
})
