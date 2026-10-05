import { dirname, joinPath } from "../source/paths"
import type { CommitInfo, GitHub, RepoRef } from "./github"

// The folders whose commits make up a project's history: its own folder, plus the folder of every
// document it uses from outside it ("..\Shared\Power.SchDoc").
export function projectFolders(prjPath: string, documentPaths: string[]): string[] {
	const folder = dirname(prjPath)
	const resolved = documentPaths.map(raw => joinPath(folder, raw.replaceAll("\\", "/"))).filter((p): p is string => p !== null)
	return foldersOf(prjPath, resolved)
}

// The same, from document paths already resolved against the repo root.
export function foldersOf(prjPath: string, repoPaths: string[]): string[] {
	const folder = dirname(prjPath)
	const inside = (p: string) => folder === "" || p === folder || p.startsWith(folder + "/")
	const out = [folder]
	for (const p of repoPaths) {
		const dir = dirname(p)
		if (!inside(dir) && !out.some(f => f !== folder && (dir === f || dir.startsWith(f + "/")))) out.push(dir)
	}
	return out
}

export type FetchCommits = (path: string, next: string | undefined) => Promise<{ items: CommitInfo[]; next: string | null }>

interface Stream {
	path: string
	next: string | undefined
	done: boolean
	buffer: CommitInfo[]
}

// Merges the paged commit lists of several folders into one newest-first list. A commit is only
// handed out once every folder that still has more pages has been read past its date, so a later
// page can't turn up something that belonged earlier.
export class ProjectHistory {
	private readonly streams: Stream[]
	private readonly seen = new Set<string>()

	constructor(
		folders: string[],
		private readonly fetchPage: FetchCommits,
	) {
		this.streams = folders.map(path => ({ path, next: undefined, done: false, buffer: [] }))
	}

	static forRepo(gh: GitHub, ref: RepoRef, branch: string, folders: string[]): ProjectHistory {
		return new ProjectHistory(folders, (path, next) => gh.commits(ref, { branch, path, next }))
	}

	get hasMore(): boolean {
		return this.streams.some(s => !s.done || s.buffer.length > 0)
	}

	async loadMore(): Promise<CommitInfo[]> {
		await Promise.all(
			this.streams
				.filter(s => !s.done && s.buffer.length === 0)
				.map(async s => {
					const p = await this.fetchPage(s.path, s.next)
					s.buffer.push(...p.items)
					s.next = p.next ?? undefined
					s.done = p.next === null
				}),
		)
		const open = this.streams.filter(s => !s.done && s.buffer.length > 0)
		const cutoff = open.length ? open.map(s => s.buffer[s.buffer.length - 1]!.date).sort().pop()! : ""
		const out: CommitInfo[] = []
		for (const s of this.streams) {
			const keep: CommitInfo[] = []
			for (const c of s.buffer) {
				if (c.date >= cutoff) {
					if (!this.seen.has(c.sha)) {
						this.seen.add(c.sha)
						out.push(c)
					}
				} else keep.push(c)
			}
			s.buffer = keep
		}
		return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
	}
}
