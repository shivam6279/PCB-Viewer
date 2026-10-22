import { expect, test } from "vitest"
import type { CommitInfo } from "../github/github"
import { newerThan } from "./newer-commits"

const c = (sha: string, day: number): CommitInfo => ({ sha, message: sha, author: "me", date: `2026-10-${String(day).padStart(2, "0")}T12:00:00Z` })
const history = [c("d", 19), c("c", 12), c("b", 4), c("a", 1)] // the project's, newest first

test("a commit in the project's history: the ones listed before it", () => {
	expect(newerThan(history, "d", null)).toEqual([])
	expect(newerThan(history, "b", null).map(x => x.sha)).toEqual(["d", "c"])
})

test("a commit that didn't change the project (or is off the branch): the ones dated after it", () => {
	expect(newerThan(history, "x", "2026-10-10T00:00:00Z").map(x => x.sha)).toEqual(["d", "c"])
	expect(newerThan(history, "x", "2026-10-20T00:00:00Z")).toEqual([])
	expect(newerThan(history, "x", null)).toEqual([])
})
