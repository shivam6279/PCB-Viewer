import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { CORPUS, hasCorpus } from "./env"
import { projectData } from "./project-data"

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
		// 3V3_LDO.SchDoc is placed twice under one designator: its C9 is C9_1 and C9_2 on the board, each
		// its own part with its own schematic component.
		const c9s = bom.lines.flatMap(l => l.designators.filter(d => /^C9_[12]$/.test(d.name)))
		expect(c9s.map(d => d.name).sort()).toEqual(["C9_1", "C9_2"])
		expect(new Set(c9s.map(d => (d.ref as { id: string }).id)).size).toBe(2)
		const c9 = bom.lines.find(l => l.designators.some(d => d.name === "C9_1"))!
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
