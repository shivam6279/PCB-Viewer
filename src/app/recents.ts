import { get, set } from "idb-keyval"

export interface RecentProject {
	name: string
	prjPath: string | null
	handle: FileSystemDirectoryHandle
	openedAt: number
}

// A project opened from GitHub: reopens at the commit it was last viewed at.
export interface GitRecent {
	name: string
	github: { owner: string; repo: string; sha: string; prjPath: string }
	openedAt: number
}

export type Recent = RecentProject | GitRecent

export const isGitRecent = (r: Recent): r is GitRecent => "github" in r

const KEY = "recent-projects"
const MAX = 8

export const recentKey = (r: Recent) => (isGitRecent(r) ? `gh:${r.github.owner}/${r.github.repo}|${r.github.prjPath}` : `${r.handle.name}|${r.prjPath ?? ""}`)

export async function listRecents(): Promise<Recent[]> {
	return ((await get<Recent[]>(KEY)) ?? []).sort((a, b) => b.openedAt - a.openedAt)
}

export async function addRecent(recent: Recent): Promise<void> {
	const rest = (await listRecents()).filter(r => recentKey(r) !== recentKey(recent))
	await set(KEY, [recent, ...rest].slice(0, MAX))
}

export async function ensureReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
	if ((await handle.queryPermission({ mode: "read" })) === "granted") return true
	return (await handle.requestPermission({ mode: "read" })) === "granted"
}
