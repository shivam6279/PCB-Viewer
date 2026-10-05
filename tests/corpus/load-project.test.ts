import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { CORPUS, hasCorpus } from "./env"
import { NodeDirSource } from "../node-dir-source"
import { findProjects, loadProject } from "../../src/model/load-project"
import { flattenHierarchy } from "../../src/model/hierarchy"
import { localParser } from "../../src/parse/parser"

describe.skipIf(!hasCorpus)("loadProject on the local corpus", () => {
	test("Cubli: REPEAT channels and the board are present, outputs are not", async () => {
		const src = new NodeDirSource(join(CORPUS, "Cubli/Main Board/STM32"))
		const p = await loadProject(src, "Cubli.PrjPcb", localParser)
		const labels = flattenHierarchy(p.hierarchy).map(n => n.label)

		expect(p.hierarchy.map(n => n.label)).toEqual(["Top.SchDoc (Top)"])
		expect(labels).toContain("ESC.SchDoc (U_ESC1)")
		expect(labels).toContain("ESC.SchDoc (U_ESC3)")
		expect(labels).toContain("Main_MCU.SchDoc (U_Main_MCU)")
		expect(labels).toContain("ESC_MCU.SchDoc (U_ESC_MCU2)") // sheets below a channel are numbered with it
		expect(p.documents.find(d => d.name === "Cubli.PcbDoc")).toMatchObject({ kind: "pcb", exists: true })
		expect(p.documents.some(d => d.name.endsWith(".GTL"))).toBe(false)
		expect(p.documents.filter(d => d.error)).toEqual([])
	})

	test("the whole corpus: every project loads without sheet errors", async () => {
		const src = new NodeDirSource(CORPUS)
		const projects = await findProjects(src)
		expect(projects.length).toBeGreaterThan(30)
		for (const prj of projects) {
			const p = await loadProject(src, prj, localParser)
			expect(p.documents.filter(d => d.error).map(d => `${prj}: ${d.name}: ${d.error}`)).toEqual([])
		}
	})
})
