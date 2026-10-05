import { expect, test } from "vitest"
import type { GitHubClient } from "./client"
import { GitHub } from "./github"
import { memoryObjectCache } from "./object-cache"
import { historyOf, StaticIndex, type IndexCommit } from "./static-index"

const c = (sha: string, parents: string[], day: number, paths: string[]): IndexCommit => ({
	sha,
	parents,
	author: "me",
	date: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
	message: sha,
	paths,
})

// main: a1 -> a2 -> a4 (head); a feature branch b3 off a2 (not on main).
const commits = [c("a4", ["a2"], 4, ["Cubli/x.SchDoc"]), c("b3", ["a2"], 3, ["Cubli/y.SchDoc"]), c("a2", ["a1"], 2, ["Other/z.PcbDoc"]), c("a1", [], 1, ["Cubli/x.SchDoc", "Other/z.PcbDoc"])]
const meta = { owner: "o", repo: "r", defaultBranch: "main", branches: { main: "a4", feature: "b3" }, generatedAt: "2026-01-05T00:00:00Z" }
const files: Record<string, unknown> = {
	"idx/o/r/meta.json": meta,
	"idx/o/r/commits.json": commits,
	"idx/o/r/trees/a4.json": [["Cubli/Cubli.PrjPcb", "p1"], ["Cubli/x.SchDoc", "s2"]],
}
const fakeFetch = (async (url: string) =>
	url in files ? new Response(JSON.stringify(files[url])) : new Response("missing", { status: 404 })) as unknown as typeof fetch

test("history: commits reachable from the branch head that touched the folder", async () => {
	const idx = (await new StaticIndex("idx/", fakeFetch).repo({ owner: "o", repo: "r" }))!
	expect(historyOf(idx, "a4", "Cubli").map(x => x.sha)).toEqual(["a4", "a1"]) // b3 is on another branch
	expect(historyOf(idx, "b3", "Cubli").map(x => x.sha)).toEqual(["b3", "a1"])
	expect(historyOf(idx, "a4", "").map(x => x.sha)).toEqual(["a4", "a2", "a1"])
})

test("an unindexed repo is null (the API is used instead)", async () => {
	expect(await new StaticIndex("idx/", fakeFetch).repo({ owner: "o", repo: "nope" })).toBeNull()
})

test("GitHub answers from the index without touching the API", async () => {
	const calls: string[] = []
	const client: GitHubClient = {
		json: async (p: string) => (calls.push(p), Promise.reject(new Error(`API ${p}`))),
		page: async (p: string) => (calls.push(p), Promise.reject(new Error(`API ${p}`))),
		pages: async (p: string) => (calls.push(p), Promise.reject(new Error(`API ${p}`))),
		raw: async (p: string) => (calls.push(p), Promise.reject(new Error(`API ${p}`))),
	}
	const gh = new GitHub(client, memoryObjectCache(), true, fakeFetch, new StaticIndex("idx/", fakeFetch))
	const ref = { owner: "o", repo: "r" }
	expect((await gh.repoInfo(ref)).defaultBranch).toBe("main")
	expect(await gh.branches(ref)).toEqual(["main", "feature"])
	expect((await gh.head(ref, "main")).sha).toBe("a4")
	expect((await gh.commit(ref, "a2")).message).toBe("a2")
	expect((await gh.commits(ref, { branch: "main", path: "Cubli" })).items.map(x => x.sha)).toEqual(["a4", "a1"])
	expect([...(await gh.tree(ref, "a4")).files.keys()]).toEqual(["Cubli/Cubli.PrjPcb", "Cubli/x.SchDoc"])
	expect(await gh.treeAtBranch(ref, "main")).toEqual(["Cubli/Cubli.PrjPcb", "Cubli/x.SchDoc"])
	expect(calls).toEqual([])
})
