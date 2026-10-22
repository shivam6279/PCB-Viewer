import { describe, expect, test } from "vitest"
import { GitHubError, type GitHubClient } from "./client"
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

describe("the index against GitHub", () => {
	const ref = { owner: "o", repo: "r" }
	const ghWith = (json: (path: string) => Promise<unknown>) => {
		const client = { json, page: json, pages: json, raw: json } as unknown as GitHubClient
		return new GitHub(client, memoryObjectCache(), true, fakeFetch, new StaticIndex("idx/", fakeFetch))
	}

	test("every branch where GitHub has it: current", async () => {
		const gh = ghWith(async () => [{ name: "main", commit: { sha: "a4" } }, { name: "feature", commit: { sha: "b3" } }])
		expect(await gh.indexFreshness(ref)).toMatchObject({ status: "current", repo: "o/r", indexedDate: "2026-01-04T00:00:00Z" })
	})

	test("GitHub moved a branch or has a new one: behind, the default branch first, with GitHub's date", async () => {
		const gh = ghWith(async path =>
			path.includes("/branches")
				? [{ name: "feature", commit: { sha: "b9" } }, { name: "main", commit: { sha: "a9" } }, { name: "new", commit: { sha: "n1" } }]
				: { sha: "a9", commit: { message: "x", author: { date: "2026-02-01T00:00:00Z" } } },
		)
		const f = await gh.indexFreshness(ref)
		expect(f).toMatchObject({ status: "behind", liveDate: "2026-02-01T00:00:00Z" })
		expect(f?.status === "behind" && f.branches).toEqual([
			{ name: "main", indexed: "a4", live: "a9" },
			{ name: "feature", indexed: "b3", live: "b9" },
			{ name: "new", indexed: null, live: "n1" },
		])
	})

	test("GitHub can't be asked (a private repo without a token): unchecked, saying why", async () => {
		const gh = ghWith(async () => Promise.reject(new GitHubError("notFound", "Not Found", 404)))
		const f = await gh.indexFreshness(ref)
		expect(f).toMatchObject({ status: "unchecked" })
		expect(f?.status === "unchecked" && f.reason).toMatch(/private/)
	})

	test("no index for the repo: nothing to check", async () => {
		expect(await ghWith(async () => []).indexFreshness({ owner: "o", repo: "nope" })).toBeNull()
	})
})
