import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { CORPUS, hasCorpus } from "./env"
import { NodeDirSource } from "../node-dir-source"
import { loadProject } from "../../src/model/load-project"
import { compileInstances, compileProject } from "../../src/model/compile"
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
