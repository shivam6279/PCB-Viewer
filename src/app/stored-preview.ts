// The board pictures the deploy publishes beside the site (tools/render-previews.mjs), read without any
// 3D code: the project page asks for its picture the moment it opens, alongside its history.
import type { RepoRef } from "../github/github"

export interface BoardStats {
	width: number // mm, the outline's box
	height: number
	thickness: number // mm
	copperLayers: number
	components: { top: number; bottom: number }
	nets: number
	vias: number
}

export interface BoardPreview {
	image: string // URL of the picture (a data URL when stored), the outline's aspect
	backdrop: "light" | "dark" // what the picture shows up against: the opposite of the top mask
	mask: string // the top mask's colour, CSS
	stats: BoardStats
}

// What the deploy stores per project and commit: the picture and its facts, or `none` without a board.
export type StoredPreview = BoardPreview | { none: true }

// Raised whenever the pictures would come out differently (model colours read better, a new camera):
// a picture is kept under the version it was drawn by, so the next deploy draws them all again.
const RENDER_VERSION = 2

// Where a project's picture is kept, under the site: previews/<owner>/<repo>/r<version>/<commit>/<the
// project file's path>.json.
export function storedPreviewPath(ref: RepoRef, sha: string, prjPath: string): string {
	return ["previews", ref.owner, ref.repo, `r${RENDER_VERSION}`, sha, ...`${prjPath}.json`.split("/")].map(encodeURIComponent).join("/")
}

// The deploy's list for a repo: the branch head it was made at, and per project the commit its picture
// belongs to plus the folders its history covers (so the page needn't read the project file for them).
export interface PreviewManifest {
	branch: string
	head: string
	projects: Record<string, { sha: string; folders: string[] }>
}

export function manifestPath(ref: RepoRef): string {
	return ["previews", ref.owner, ref.repo, "index.json"].map(encodeURIComponent).join("/")
}

const site = (path: string) => new URL(path, document.baseURI)

// JSON published with the site, or null (not there: the dev server, or not made yet).
async function siteJson<T>(path: string): Promise<T | null> {
	try {
		const res = await fetch(site(path))
		if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null
		return (await res.json()) as T
	} catch {
		return null
	}
}

const manifests = new Map<string, Promise<PreviewManifest | null>>()

// Fetched once per visit; the home screen starts it, so a project page usually finds it in.
export function previewManifest(ref: RepoRef): Promise<PreviewManifest | null> {
	const key = `${ref.owner}/${ref.repo}`
	let p = manifests.get(key)
	if (!p) manifests.set(key, (p = siteJson<PreviewManifest>(manifestPath(ref))))
	return p
}

const stored = new Map<string, Promise<BoardPreview | null | undefined>>()

// The published picture, decoded and ready to show: null for a project with no board, undefined when
// there is none (a commit newer than the last deploy, or the dev server).
export function storedPreview(ref: RepoRef, sha: string, prjPath: string): Promise<BoardPreview | null | undefined> {
	const path = storedPreviewPath(ref, sha, prjPath)
	let p = stored.get(path)
	if (!p) {
		p = siteJson<StoredPreview>(path).then(async s => {
			if (!s) return undefined
			if ("none" in s) return null
			await decoded(s.image)
			return s
		})
		stored.set(path, p)
	}
	return p
}

// Waits until the picture is decoded, so it shows in one go rather than painting in.
export async function decoded(src: string): Promise<void> {
	const img = new Image()
	img.src = src
	await img.decode().catch(() => {})
}
