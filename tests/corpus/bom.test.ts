import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { CORPUS, hasCorpus } from "./env"
import { NodeDirSource } from "../node-dir-source"
import { loadProject } from "../../src/model/load-project"
import { compileInstances } from "../../src/model/compile"
import { localParser } from "../../src/parse/parser"
import { buildProjectData } from "../../src/parse/project-data"

async function projectData(dir: string, prj: string) {
	const project = await loadProject(new NodeDirSource(dir), prj, localParser)
	const read = (path: string) => new Uint8Array(readFileSync(join(dir, path)))
	const pcb = project.documents.find(d => d.kind === "pcb" && d.exists)
	const bomDoc = project.documents.find(d => /\.bomdoc$/i.test(d.path) && d.exists)
	return buildProjectData({
		instances: compileInstances(project.hierarchy),
		designatorFormat: project.channelDesignatorFormat,
		sheets: project.documents.filter(d => d.kind === "sch" && d.exists).map(d => [d.path, read(d.path)]),
		pcb: pcb ? read(pcb.path) : null,
		bomDoc: bomDoc ? { name: bomDoc.path, bytes: read(bomDoc.path) } : null,
	})
}

describe.skipIf(!hasCorpus)("BOM", () => {
	test("POVRotor: board parts, every line found in its BOM document", async () => {
		const data = await projectData(join(CORPUS, "POV/POVRotor/Rev3"), "POVRotor.PrjPcb")
		const bom = data.bom!
		expect(bom.source).toBe("board")
		expect(bom.bomDoc).toBe("POVRotor.BomDoc")
		expect(bom.lines.filter(l => !l.fromBomDoc).map(l => l.designators[0]!.name)).toEqual([])
		// Every board part is linked to its schematic component.
		const unlinked = bom.lines.flatMap(l => l.designators.filter(d => d.ref.kind !== "component").map(d => d.name))
		expect(unlinked).toEqual([])
		// 3V3_LDO.SchDoc is placed twice under one designator: two C9s on the board, each its own part
		// with its own schematic component.
		const c9s = bom.lines.flatMap(l => l.designators.filter(d => d.name === "C9"))
		expect(c9s).toHaveLength(2)
		expect(new Set(c9s.map(d => (d.ref as { id: string }).id)).size).toBe(2)
		const c9 = bom.lines.find(l => l.designators.some(d => d.name === "C9"))!
		expect(c9.comment).toBe("2.2 µF")
		expect(c9.mpn).toBe("C0402C104K4RACAUTO")
	})

	test("Cubli: channel copies under their compiled designators, all linked", async () => {
		const data = await projectData(join(CORPUS, "Cubli/Main Board/STM32"), "Cubli.PrjPcb")
		const bom = data.bom!
		expect(bom.bomDoc).toBeNull()
		const names = bom.lines.flatMap(l => l.designators.map(d => d.name))
		expect(names).toContain("U13_ESC_3")
		expect(new Set(names).size).toBe(names.length)
		expect(bom.lines.flatMap(l => l.designators.filter(d => d.ref.kind !== "component").map(d => d.name))).toEqual([])
	})
})
