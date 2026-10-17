// For tools/render-previews.mjs (the deploy): the site opened with ?render-previews gets two functions
// it calls from the outside. __previewPlan lists every project with the commit its picture belongs to
// (the newest touching it) and the folders its history covers; __renderPreview draws one, ready to store.
import { renderForStore } from "../3d/board-preview"
import { storedPreviewPath, type StoredPreview } from "./stored-preview"
import { OWNER } from "../github/config"
import { discoverProjects } from "../github/discovery"
import { currentGitHub } from "../github/session"
import { latestProjectCommit } from "./project-history"

export interface PreviewJob {
	owner: string
	repo: string
	branch: string
	prjPath: string
	sha: string
	folders: string[] // the folders the project's history covers
	head: string // the branch head they were read at
	path: string // where the picture is kept, under the site
}

declare global {
	interface Window {
		__previewPlan?: () => Promise<PreviewJob[]>
		__renderPreview?: (job: PreviewJob) => Promise<StoredPreview>
	}
}

window.__previewPlan = async () => {
	const gh = currentGitHub()
	const { projects } = await discoverProjects(gh, OWNER)
	const jobs: PreviewJob[] = []
	for (const p of projects) {
		const ref = { owner: p.owner, repo: p.repo }
		const latest = await latestProjectCommit(gh, ref, p.branch, p.prjPath)
		if (latest) jobs.push({ ...ref, branch: p.branch, prjPath: p.prjPath, ...latest, path: decodeURIComponent(storedPreviewPath(ref, latest.sha, p.prjPath)) })
	}
	return jobs
}

window.__renderPreview = job => renderForStore(currentGitHub(), { owner: job.owner, repo: job.repo }, job.sha, job.prjPath)
