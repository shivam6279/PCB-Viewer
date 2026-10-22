import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { CORPUS, hasCorpus } from "./env"
import { projectData } from "./project-data"
import { getPcbScene } from "../../src/parse/project-data"

describe.skipIf(!hasCorpus)("designators", () => {
	// PnP places CAN_PHY.SchDoc by two sheet symbols (CAN0, CAN1) and stepper_driver.SchDoc by eight:
	// the sheets say TVS1 and C10, the board TVS1_CAN0 and C10_STP8.
	test("PnP: every part by its physical designator, the logical one kept", async () => {
		const data = await projectData(join(CORPUS, "PnP/PnP"), "PnP.PrjPcb")
		const tvs = data.compiled.components.filter(c => c.logicalDesignator === "TVS1").map(c => c.designator).sort()
		expect(tvs).toEqual(["TVS1_CAN0", "TVS1_CAN1"])
		expect(data.compiled.components.some(c => c.designator === "C10_STP8")).toBe(true)
		// The board's parts: one designator each.
		const scene = getPcbScene()!
		const names = scene.components.map(c => c.designator)
		expect(new Set(names).size).toBe(names.length)
		expect(names).toContain("TVS1_CAN0")
		expect(scene.components.find(c => c.designator === "TVS1_CAN1")!.logicalDesignator).toBe("TVS1")
		// The schematic's parts name the same board parts.
		const board = new Map(scene.components.map(c => [c.sourceUniqueId, c.designator]))
		for (const c of data.compiled.components) if (board.has(c.uniquePath)) expect(c.designator).toBe(board.get(c.uniquePath))
	})
})
