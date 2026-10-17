// For tools/render-previews.mjs (the deploy): the site opened with ?render-previews gets two functions
// it calls from the outside. __previewPlan lists every project with the commit its picture belongs to
// (the newest touching it); __renderPreview draws one, ready to store.
import { renderForStore, storedPreviewPath, type StoredPreview } from "../3d/board-preview"
import { OWNER } from "../github/config"
import { discoverProjects } from "../github/discovery"
import { currentGitHub } from "../github/session"
import { latestProjectCommit } from "./project-history"

export interface PreviewJob {
	owner: string
	repo: string
	prjPath: string
	sha: string
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
		const sha = await latestProjectCommit(gh, ref, p.branch, p.prjPath)
		if (sha) jobs.push({ ...ref, prjPath: p.prjPath, sha, path: decodeURIComponent(storedPreviewPath(ref, sha, p.prjPath)) })
	}
	return jobs
}

window.__renderPreview = job => renderForStore(currentGitHub(), { owner: job.owner, repo: job.repo }, job.sha, job.prjPath)
