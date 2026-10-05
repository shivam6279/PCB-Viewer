import { expect, test } from "vitest"
import { defaultOwner, OWNER, REPOS } from "./config"

test("the site reads the owner's configured repos", () => {
	expect(defaultOwner()).toBe(OWNER)
	expect(REPOS).toContain("PCB")
})
