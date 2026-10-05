// The GitHub index published with the site (tools/build-index.mjs, run by the deploy workflow): every
// commit, branch and file list of the configured repos, read as static files from the site itself —
// so browsing costs no GitHub API requests (a visitor without a token gets 60 an hour).
import type { CommitInfo, RepoRef } from "./github"

export interface IndexCommit {
	sha: string
	parents: string[]
	author: string
	date: string
	message: string
	paths: string[] // changed against the first parent
}

export interface IndexMeta {
	owner: string
	repo: string
	defaultBranch: string
	branches: Record<string, string>
	generatedAt: string
}

interface RepoIndex {
	meta: IndexMeta
	commits: IndexCommit[]
	bySha: Map<string, IndexCommit>
}

export class StaticIndex {
	private readonly repos = new Map<string, Promise<RepoIndex | null>>()

	// `base`: the folder the index is served from ("index/" beside the page); `fetchFn` for tests.
	constructor(
		private readonly base: string,
		private readonly fetchFn: typeof fetch = (...a) => globalThis.fetch(...a),
	) {}

	// The repo's index, or null when the site has none for it (then the API is used).
	repo(r: RepoRef): Promise<RepoIndex | null> {
		const key = `${r.owner}/${r.repo}`
		let p = this.repos.get(key)
		if (!p) {
			p = (async () => {
				const dir = `${this.base}${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/`
				const [meta, commits] = await Promise.all([this.json<IndexMeta>(`${dir}meta.json`), this.json<IndexCommit[]>(`${dir}commits.json`)])
				if (!meta || !commits) return null
				return { meta, commits, bySha: new Map(commits.map(c => [c.sha, c])) }
			})()
			this.repos.set(key, p)
		}
		return p
	}

	// The files at an indexed commit (path -> blob sha), or null if it isn't indexed.
	async tree(r: RepoRef, sha: string): Promise<Map<string, string> | null> {
		const idx = await this.repo(r)
		if (!idx?.bySha.has(sha)) return null
		const rows = await this.json<[string, string][]>(`${this.base}${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/trees/${sha}.json`)
		return rows ? new Map(rows) : null
	}

	private async json<T>(url: string): Promise<T | null> {
		try {
			const res = await this.fetchFn(url)
			if (!res.ok) return null
			return (await res.json()) as T
		} catch {
			return null
		}
	}
}

export const toCommitInfo = (c: IndexCommit): CommitInfo => ({ sha: c.sha, message: c.message, author: c.author, date: c.date })

// Commits reachable from `head` (newest first) that changed something under `path` ("" = any).
export function historyOf(idx: RepoIndex, head: string, path: string): CommitInfo[] {
	const reach = new Set<string>()
	const stack = [head]
	while (stack.length) {
		const sha = stack.pop()!
		if (reach.has(sha)) continue
		reach.add(sha)
		for (const p of idx.bySha.get(sha)?.parents ?? []) stack.push(p)
	}
	const prefix = path ? `${path}/` : ""
	return idx.commits.filter(c => reach.has(c.sha) && (prefix === "" || c.paths.some(p => p.startsWith(prefix)))).map(toCommitInfo)
}
