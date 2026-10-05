import { expect, test } from "vitest"
import { basename, dirname, extname, joinPath, normalizePath, PathIndex, stripExt } from "./paths"

test("normalizePath handles backslashes, dots and root escapes", () => {
	expect(normalizePath("a\\b\\..\\c.SchDoc")).toBe("a/c.SchDoc")
	expect(normalizePath("./a//b")).toBe("a/b")
	expect(normalizePath("../outside.SchDoc")).toBeNull()
})

test("joinPath resolves relative to a directory", () => {
	expect(joinPath("proj/rev1", "..\\shared\\Power.SchDoc")).toBe("proj/shared/Power.SchDoc")
	expect(joinPath("", "Top.SchDoc")).toBe("Top.SchDoc")
	expect(joinPath("proj", "..\\..\\x.SchDoc")).toBeNull()
})

test("name helpers", () => {
	expect(dirname("a/b/c.PcbDoc")).toBe("a/b")
	expect(dirname("c.PcbDoc")).toBe("")
	expect(basename("a/b/c.PcbDoc")).toBe("c.PcbDoc")
	expect(extname("a/b/c.PcbDoc")).toBe(".pcbdoc")
	expect(extname("a/b/README")).toBe("")
	expect(stripExt("a/Top.SchDoc")).toBe("Top")
})

test("PathIndex is case-insensitive and returns the on-disk spelling", () => {
	const index = new PathIndex(["Proj/Top.SchDoc"])
	expect(index.get("proj/TOP.schdoc")).toBe("Proj/Top.SchDoc")
	expect(index.get("proj/missing.SchDoc")).toBeUndefined()
})
