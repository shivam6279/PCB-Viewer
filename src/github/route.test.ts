import { expect, test } from "vitest"
import { formatRoute, parseRoute, type Route } from "./route"

const sha = "0123456789abcdef0123456789abcdef01234567"

test.each<Route>([
	{ kind: "home" },
	{ kind: "ghProject", owner: "shivam6279", repo: "PCB", prjPath: "Cubli/Main Board/STM32/Cubli.PrjPcb", branch: "main" },
	{ kind: "ghProject", owner: "a", repo: "b", prjPath: "X#1/Y?.PrjPcb", branch: null },
	{ kind: "ghCommit", owner: "shivam6279", repo: "PCB", sha, prjPath: "Cubli/Main Board/STM32/Cubli.PrjPcb" },
	{ kind: "ghCommit", owner: "o", repo: "r", sha, prjPath: "A/B.PrjPcb", vs: "fedcba9876543210fedcba9876543210fedcba98" },
])("round-trips %o", r => {
	expect(parseRoute(formatRoute(r))).toEqual(r)
})

test("encodes spaces in folder names", () => {
	expect(formatRoute({ kind: "ghCommit", owner: "o", repo: "r", sha, prjPath: "Main Board/A.PrjPcb" })).toBe(`#/gh/o/r/${sha}/Main%20Board/A.PrjPcb`)
})

test("anything unrecognised is home", () => {
	for (const h of ["", "#", "#/", "#/gh/o/r", "#/gh/o/r/notasha/x.PrjPcb", "#/other/thing/a/b/c"]) expect(parseRoute(h)).toEqual({ kind: "home" })
})
