import { expect, test } from "vitest"
import type { CommitInfo } from "./github"
import { ProjectHistory, projectFolders, type FetchCommits } from "./history"

test("project folders: own folder plus outside folders, nested ones collapsed", () => {
	expect(
		projectFolders("Cubli/Main/Cubli.PrjPcb", ["Top.SchDoc", "Sheets\\Power.SchDoc", "..\\..\\Shared\\Usb.SchDoc", "..\\..\\Shared\\Sub\\X.SchDoc", "..\\Other\\B.PcbDoc"]),
	).toEqual(["Cubli/Main", "Shared", "Cubli/Other"])
	expect(projectFolders("A.PrjPcb", ["x/B.SchDoc"])).toEqual([""])
})

const c = (sha: string, day: number): CommitInfo => ({ sha, message: sha, author: "me", date: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z` })

// Pages of size 2 from a fixed newest-first list per path.
function pager(lists: Record<string, CommitInfo[]>): { fetch: FetchCommits; calls: string[] } {
	const calls: string[] = []
	const fetch: FetchCommits = async (path, next) => {
		calls.push(`${path}:${next ?? 0}`)
		const start = Number(next ?? 0)
		const items = lists[path]!.slice(start, start + 2)
		return { items, next: start + 2 < lists[path]!.length ? String(start + 2) : null }
	}
	return { fetch, calls }
}

test("merges several folders newest first, deduplicated, across pages", async () => {
	const { fetch } = pager({
		a: [c("a9", 9), c("s8", 8), c("a5", 5), c("a1", 1)],
		b: [c("s8", 8), c("b7", 7), c("b6", 6)],
	})
	const h = new ProjectHistory(["a", "b"], fetch)
	const all: string[] = []
	while (h.hasMore) all.push(...(await h.loadMore()).map(x => x.sha))
	expect(all).toEqual(["a9", "s8", "b7", "b6", "a5", "a1"])
})

test("never hands out a commit before a folder with more pages has been read past it", async () => {
	const { fetch } = pager({
		a: [c("a9", 9), c("a8", 8), c("a2", 2)],
		b: [c("b7", 7), c("b6", 6), c("b5", 5), c("b4", 4)],
	})
	const h = new ProjectHistory(["a", "b"], fetch)
	const first = (await h.loadMore()).map(x => x.sha)
	expect(first).toEqual(["a9", "a8"]) // b7 waits: a's next page could hold something newer than it
	expect((await h.loadMore()).map(x => x.sha)).toEqual(["b7", "b6"])
	expect((await h.loadMore()).map(x => x.sha)).toEqual(["b5", "b4", "a2"])
	expect(h.hasMore).toBe(false)
})
