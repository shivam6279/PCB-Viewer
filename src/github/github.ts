import { GitHubError, type GitHubClient, type Page } from "./client"
import { historyOf, toCommitInfo, type StaticIndex } from "./static-index"
import type { ObjectCache } from "./object-cache"

export interface RepoRef {
	owner: string
	repo: string
}

export interface Repo extends RepoRef {
	defaultBranch: string
	private: boolean
	pushedAt: string
}

export interface CommitInfo {
	sha: string
	message: string // first line
	author: string
	date: string // ISO
}

export interface Tree {
	files: Map<string, string> // path -> blob sha
	truncated: boolean
}

const enc = encodeURIComponent
const repoPath = (r: RepoRef) => `/repos/${enc(r.owner)}/${enc(r.repo)}`
const encPath = (p: string) => p.split("/").map(enc).join("/")

interface RawTree {
	sha: string
	truncated: boolean
	tree: { path: string; type: string; sha: string }[]
}

interface RawCommit {
	sha: string
	commit: { message: string; author: { name: string; date: string } | null }
	author: { login: string } | null
}

const toCommit = (c: RawCommit): CommitInfo => ({
	sha: c.sha,
	message: c.commit.message.split("\n")[0]!,
	author: c.commit.author?.name ?? c.author?.login ?? "",
	date: c.commit.author?.date ?? "",
})

// The GitHub calls the viewer makes. Everything addressed by a sha goes through the object cache.
export class GitHub {
	constructor(
		readonly client: GitHubClient,
		readonly cache: ObjectCache,
		// No token: public repos only, files from GitHub's raw-file CDN (it doesn't count against the
		// API's per-visitor limit, which a token-less visitor would otherwise spend on file downloads).
		readonly anonymous = false,
		private readonly fetchRaw: typeof fetch = (...a) => globalThis.fetch(...a),
		// The index published with the site: commits, branches and file lists without API requests.
		// Anything it doesn't have (a commit newer than the last deploy) comes from the API.
		readonly index: StaticIndex | null = null,
	) {}

	user(): Promise<{ login: string }> {
		return this.client.json("/user")
	}


	private readonly repoInfos = new Map<string, Promise<Repo>>()

	// A repo's facts (its default branch) for this visit: asked once, not on every screen.
	repoInfo(r: RepoRef): Promise<Repo> {
		const key = `${r.owner}/${r.repo}`
		let p = this.repoInfos.get(key)
		if (!p) {
			p = this.fetchRepoInfo(r)
			p.catch(() => this.repoInfos.delete(key))
			this.repoInfos.set(key, p)
		}
		return p
	}

	private async fetchRepoInfo(r: RepoRef): Promise<Repo> {
		const idx = await this.index?.repo(r)
		if (idx) {
			// The default branch's head stands in for the push time: it changes exactly when there is news.
			return { owner: r.owner, repo: r.repo, defaultBranch: idx.meta.defaultBranch, private: false, pushedAt: idx.meta.branches[idx.meta.defaultBranch] ?? idx.meta.generatedAt }
		}
		const raw = await this.client.json<{ name: string; owner: { login: string }; default_branch: string; private: boolean; pushed_at: string }>(repoPath(r))
		return { owner: raw.owner.login, repo: raw.name, defaultBranch: raw.default_branch, private: raw.private, pushedAt: raw.pushed_at }
	}


	async branches(r: RepoRef): Promise<string[]> {
		const idx = await this.index?.repo(r)
		if (idx) return [idx.meta.defaultBranch, ...Object.keys(idx.meta.branches).filter(b => b !== idx.meta.defaultBranch).sort()]
		return (await this.client.pages<{ name: string }>(`${repoPath(r)}/branches?per_page=100`)).map(b => b.name)
	}

	async head(r: RepoRef, branch: string): Promise<CommitInfo> {
		const idx = await this.index?.repo(r)
		const c = idx?.bySha.get(idx.meta.branches[branch] ?? "")
		if (c) return toCommitInfo(c)
		return toCommit(await this.client.json<RawCommit>(`${repoPath(r)}/commits/${enc(branch)}`))
	}

	async commit(r: RepoRef, sha: string): Promise<CommitInfo> {
		const key = `commit:${sha}`
		const hit = await this.cache.getJson<CommitInfo>(key)
		if (hit) return hit
		const indexed = (await this.index?.repo(r))?.bySha.get(sha)
		if (indexed) return toCommitInfo(indexed)
		const c = toCommit(await this.client.json<RawCommit>(`${repoPath(r)}/commits/${enc(sha)}`))
		await this.cache.putJson(key, c)
		return c
	}

	// Commits touching a path, newest first. Pass the returned `next` back in to get the following page.
	async commits(r: RepoRef, opts: { branch: string; path: string; perPage?: number; next?: string; background?: boolean }): Promise<Page<CommitInfo>> {
		const idx = opts.next ? null : await this.index?.repo(r)
		const head = idx?.meta.branches[opts.branch]
		if (idx && head) {
			const all = historyOf(idx, head, opts.path)
			return { items: opts.perPage ? all.slice(0, opts.perPage) : all, next: null } // the whole history at once
		}
		const url = opts.next ?? `${repoPath(r)}/commits?sha=${enc(opts.branch)}&path=${enc(opts.path)}&per_page=${opts.perPage ?? 100}`
		const p = await this.client.page<RawCommit>(url, { background: opts.background })
		return { items: p.items.map(toCommit), next: p.next }
	}

	// Every file at a commit. GitHub truncates huge trees; then only `scope` (a folder) is listed.
	async tree(r: RepoRef, commitSha: string, scope = ""): Promise<Tree> {
		const key = `tree:${r.owner}/${r.repo}:${commitSha}`
		const hit = await this.cache.getJson<{ files: [string, string][]; truncated: boolean }>(key)
		if (hit && !hit.truncated) return { files: new Map(hit.files), truncated: false }
		const indexed = await this.index?.tree(r, commitSha)
		if (indexed) {
			await this.cache.putJson(key, { files: [...indexed], truncated: false })
			return { files: indexed, truncated: false }
		}
		const full = await this.client.json<RawTree>(`${repoPath(r)}/git/trees/${enc(commitSha)}?recursive=1`)
		if (!full.truncated) {
			const files = full.tree.filter(e => e.type === "blob").map(e => [e.path, e.sha] as [string, string])
			await this.cache.putJson(key, { files, truncated: false })
			return { files: new Map(files), truncated: false }
		}
		return { files: await this.scopedTree(r, commitSha, scope), truncated: true }
	}

	private async scopedTree(r: RepoRef, commitSha: string, scope: string): Promise<Map<string, string>> {
		let treeSha = commitSha
		const parts = scope.split("/").filter(Boolean)
		for (const part of parts) {
			const level = await this.client.json<RawTree>(`${repoPath(r)}/git/trees/${enc(treeSha)}`)
			const dir = level.tree.find(e => e.type === "tree" && e.path === part)
			if (!dir) return new Map()
			treeSha = dir.sha
		}
		const sub = await this.client.json<RawTree>(`${repoPath(r)}/git/trees/${enc(treeSha)}?recursive=1`)
		const prefix = parts.length ? parts.join("/") + "/" : ""
		return new Map(sub.tree.filter(e => e.type === "blob").map(e => [prefix + e.path, e.sha]))
	}

	// The files at a branch's head, in one request (a branch moves, so this is not cached by sha; the
	// caller caches what it derives from it by the repo's push time).
	async treeAtBranch(r: RepoRef, branch: string): Promise<string[]> {
		const idx = await this.index?.repo(r)
		const head = idx?.meta.branches[branch]
		if (head) {
			const files = await this.index!.tree(r, head)
			if (files) return [...files.keys()]
		}
		const t = await this.client.json<RawTree>(`${repoPath(r)}/git/trees/${enc(branch)}?recursive=1`)
		return t.tree.filter(e => e.type === "blob").map(e => e.path)
	}

	private readonly blobsInFlight = new Map<string, Promise<Uint8Array>>()

	// Concurrent reads of one blob (the project loader and the data loader both read every sheet)
	// share a single download.
	blob(r: RepoRef, sha: string): Promise<Uint8Array> {
		let p = this.blobsInFlight.get(sha)
		if (!p) {
			p = (async () => {
				const hit = await this.cache.getBlob(sha)
				if (hit) return hit
				const bytes = await this.client.raw(`${repoPath(r)}/git/blobs/${enc(sha)}`)
				await this.cache.putBlob(sha, bytes)
				return bytes
			})().finally(() => this.blobsInFlight.delete(sha))
			this.blobsInFlight.set(sha, p)
		}
		return p
	}

	// A file at a commit, by its blob sha (the cache key: the same content in any commit is fetched once).
	// Signed in it comes through the API (private repos too); anonymous, from the raw-file CDN.
	async file(r: RepoRef, commitSha: string, path: string, blobSha: string): Promise<Uint8Array> {
		if (!this.anonymous) return this.blob(r, blobSha)
		let p = this.blobsInFlight.get(blobSha)
		if (!p) {
			p = (async () => {
				const hit = await this.cache.getBlob(blobSha)
				if (hit) return hit
				const res = await this.fetchRaw(`https://raw.githubusercontent.com/${enc(r.owner)}/${enc(r.repo)}/${commitSha}/${encPath(path)}`).catch(() => {
					throw new GitHubError("network", typeof navigator !== "undefined" && navigator.onLine === false ? "You're offline" : "Couldn't reach GitHub")
				})
				if (!res.ok) throw new GitHubError(res.status === 404 ? "notFound" : "other", `Couldn't download ${path} (${res.status})`, res.status)
				const bytes = new Uint8Array(await res.arrayBuffer())
				await this.cache.putBlob(blobSha, bytes)
				return bytes
			})().finally(() => this.blobsInFlight.delete(blobSha))
			this.blobsInFlight.set(blobSha, p)
		}
		return p
	}

	// One file at a ref (branch or sha), without listing the whole tree.
	async fileAt(r: RepoRef, ref: string, path: string): Promise<Uint8Array> {
		return this.client.raw(`${repoPath(r)}/contents/${encPath(path)}?ref=${enc(ref)}`)
	}
}
