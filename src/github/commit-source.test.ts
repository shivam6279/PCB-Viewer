import { expect, test } from "vitest"
import { SourceFileNotFound } from "../source/types"
import type { GitHubClient } from "./client"
import { GitCommitSource } from "./commit-source"
import { GitHub } from "./github"
import { memoryObjectCache } from "./object-cache"

const enc = new TextEncoder()

function fakeClient(routes: Record<string, unknown>, blobs: Record<string, Uint8Array>) {
	const hits: string[] = []
	const client: GitHubClient = {
		async json<T>(path: string) {
			hits.push(path)
			if (!(path in routes)) throw new Error(`unrouted ${path}`)
			return routes[path] as T
		},
		page: async () => ({ items: [], next: null }),
		pages: async () => [],
		async raw(path: string) {
			hits.push(path)
			const sha = path.split("/").pop()!
			if (!blobs[sha]) throw new Error(`no blob ${sha}`)
			return blobs[sha]!
		},
	}
	return { client, hits }
}

const ref = { owner: "me", repo: "PCB" }
const tree = (entries: [string, string, string][], truncated = false) => ({
	sha: "t",
	truncated,
	tree: entries.map(([path, type, sha]) => ({ path, type, sha })),
})

test("lists blobs at the commit, skipping housekeeping folders", async () => {
	const { client } = fakeClient(
		{
			"/repos/me/PCB/git/trees/c1abcdef99?recursive=1": tree([
				["Cubli", "tree", "d"],
				["Cubli/Cubli.PrjPcb", "blob", "b1"],
				["Cubli/Top.SchDoc", "blob", "b2"],
				["Cubli/History/Top~1.SchDoc", "blob", "b3"],
			]),
		},
		{},
	)
	const src = new GitCommitSource(new GitHub(client, memoryObjectCache()), ref, "c1abcdef99")
	expect(src.name).toBe("PCB @ c1abcde")
	await expect(src.list()).resolves.toEqual(["Cubli/Cubli.PrjPcb", "Cubli/Top.SchDoc"])
})

test("reads blobs once, then from the cache — also across commits sharing a blob", async () => {
	const { client, hits } = fakeClient(
		{
			"/repos/me/PCB/git/trees/c1?recursive=1": tree([["a.SchDoc", "blob", "b1"]]),
			"/repos/me/PCB/git/trees/c2?recursive=1": tree([["a.SchDoc", "blob", "b1"]]),
		},
		{ b1: new Uint8Array([9]) },
	)
	const gh = new GitHub(client, memoryObjectCache())
	expect(await new GitCommitSource(gh, ref, "c1").read("a.SchDoc")).toEqual(new Uint8Array([9]))
	expect(await new GitCommitSource(gh, ref, "c1").read("a.SchDoc")).toEqual(new Uint8Array([9]))
	expect(await new GitCommitSource(gh, ref, "c2").read("a.SchDoc")).toEqual(new Uint8Array([9]))
	expect(hits.filter(h => h.includes("/blobs/"))).toHaveLength(1)
	// the c1 tree is cached by sha too
	expect(hits.filter(h => h.includes("trees/c1"))).toHaveLength(1)
})

test("a missing path is SourceFileNotFound", async () => {
	const { client } = fakeClient({ "/repos/me/PCB/git/trees/c1?recursive=1": tree([]) }, {})
	const src = new GitCommitSource(new GitHub(client, memoryObjectCache()), ref, "c1")
	await expect(src.read("nope.SchDoc")).rejects.toBeInstanceOf(SourceFileNotFound)
})

test("an LFS pointer is reported by name", async () => {
	const { client } = fakeClient(
		{ "/repos/me/PCB/git/trees/c1?recursive=1": tree([["big.PcbDoc", "blob", "p"]]) },
		{ p: enc.encode("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n") },
	)
	const src = new GitCommitSource(new GitHub(client, memoryObjectCache()), ref, "c1")
	await expect(src.read("big.PcbDoc")).rejects.toThrow("big.PcbDoc is stored in Git LFS")
})

test("a truncated tree falls back to listing just the project folder", async () => {
	const { client } = fakeClient(
		{
			"/repos/me/PCB/git/trees/c1?recursive=1": tree([["x", "blob", "x"]], true),
			"/repos/me/PCB/git/trees/c1": tree([["Cubli", "tree", "dc"]]),
			"/repos/me/PCB/git/trees/dc": tree([["Main", "tree", "dm"]]),
			"/repos/me/PCB/git/trees/dm?recursive=1": tree([
				["Cubli.PrjPcb", "blob", "b1"],
				["Sheets/Top.SchDoc", "blob", "b2"],
			]),
		},
		{},
	)
	const src = new GitCommitSource(new GitHub(client, memoryObjectCache()), ref, "c1", "Cubli/Main")
	await expect(src.list()).resolves.toEqual(["Cubli/Main/Cubli.PrjPcb", "Cubli/Main/Sheets/Top.SchDoc"])
})
