import { GitCommitSource } from "../github/commit-source"
import type { GitHub, RepoRef } from "../github/github"
import { ProjectHistory, projectFolders } from "../github/history"
import { workerParser } from "../parse/worker-parser"
import { dirname } from "../source/paths"

// The history covers the project's folder plus folders it borrows documents from. That is fixed for a
// commit, so it is cached by sha: coming back here doesn't wait on the parse worker (busy compiling
// the commit just left).
export async function historyFolders(gh: GitHub, ref: RepoRef, sha: string, prjPath: string): Promise<string[]> {
	const key = `folders:${ref.owner}/${ref.repo}:${sha}:${prjPath}`
	const hit = await gh.cache.getJson<string[]>(key)
	if (hit) return hit
	let folders = [dirname(prjPath)]
	try {
		const prj = await new GitCommitSource(gh, ref, sha, dirname(prjPath)).read(prjPath)
		folders = projectFolders(prjPath, (await workerParser().parseProjectFile(prj)).documentPaths)
	} catch {
		return folders // not at the head of this branch: its own folder's history still applies
	}
	await gh.cache.putJson(key, folders)
	return folders
}

// The newest commit on a branch that touches the project (its own folder or one it borrows from): the
// commit its board picture is made at, so a push elsewhere in the repo doesn't call for a new one.
export async function latestProjectCommit(gh: GitHub, ref: RepoRef, branch: string, prjPath: string): Promise<string | null> {
	const head = await gh.head(ref, branch)
	const folders = await historyFolders(gh, ref, head.sha, prjPath)
	const [first] = await ProjectHistory.forRepo(gh, ref, branch, folders).loadMore()
	return first?.sha ?? null
}
