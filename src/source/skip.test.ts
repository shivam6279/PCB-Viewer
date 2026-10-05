import { expect, test } from "vitest"
import { isInSkippedDir, shouldSkipDir } from "./skip"

test("skips Altium housekeeping and VCS folders", () => {
	for (const n of [".git", "History", "__Previews", "Project Logs for Cubli", "Project Outputs for Sensor", "Project Outputs", "Project Logs", "node_modules"])
		expect(shouldSkipDir(n)).toBe(true)
	for (const n of ["Rev1", "Main Board", "Outputs"]) expect(shouldSkipDir(n)).toBe(false)
})

test("isInSkippedDir checks every directory segment", () => {
	expect(isInSkippedDir("Cubli/History/old.PrjPcb")).toBe(true)
	expect(isInSkippedDir("Cubli/Rev1/Cubli.PrjPcb")).toBe(false)
	expect(isInSkippedDir("Top.PrjPcb")).toBe(false)
})
