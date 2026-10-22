// Whether a commit is the latest for a project: the commits after it that changed the project, on the
// repo's default branch (its history, newest first).
import type { CommitInfo, GitHub, RepoRef } from "../github/github"
import { foldersOf, ProjectHistory } from "../github/history"

// The commits in `history` newer than `sha`: those listed before it, or (a commit that changed nothing
// in the project, or is off the branch) those dated after it. Pure.
export function newerThan(history: CommitInfo[], sha: string, date: string | null): CommitInfo[] {
	const at = history.findIndex(c => c.sha === sha)
	if (at >= 0) return history.slice(0, at)
	if (!date) return []
	const when = Date.parse(date)
	return history.filter(c => Date.parse(c.date) > when)
}

// The same, fetched: the project's history (the folder of its project file) and the commit's date.
export async function newerCommits(gh: GitHub, ref: RepoRef, sha: string, prjPath: string): Promise<CommitInfo[]> {
	const repo = await gh.repoInfo(ref)
	const history = await ProjectHistory.forRepo(gh, ref, repo.defaultBranch, foldersOf(prjPath, [])).loadMore()
	if (history[0]?.sha === sha) return []
	const commit = history.some(c => c.sha === sha) ? null : await gh.commit(ref, sha).catch(() => null)
	return newerThan(history, sha, commit?.date ?? null)
}
