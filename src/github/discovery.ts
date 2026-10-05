import { extname, stripExt } from "../source/paths"
import { isInSkippedDir } from "../source/skip"
import { GitHubError } from "./client"
import { REPOS } from "./config"
import type { GitHub, Repo } from "./github"

export interface GhProject {
	owner: string
	repo: string
	branch: string
	prjPath: string
	name: string
}

export interface Discovery {
	projects: GhProject[]
	failed: { repo: string; message: string }[]
}

// Every .PrjPcb on the default branch of the configured repos. A repo is only looked into again once
// it has been pushed to: its projects are remembered with its push time, so a visit costs one request
// per repo (its facts), plus one for its file list after a push.
export async function discoverProjects(gh: GitHub, owner: string, onRepo?: (d: Discovery) => void): Promise<Discovery> {
	const repos = await Promise.all(REPOS.map(repo => gh.repoInfo({ owner, repo })))
	const result: Discovery = { projects: [], failed: [] }
	await Promise.all(
		repos.map(async r => {
			try {
				result.projects.push(...(await projectsIn(gh, r)))
			} catch (e) {
				if (e instanceof GitHubError && e.kind === "auth") throw e
				if (e instanceof GitHubError && e.status === 409) return // empty repo
				result.failed.push({ repo: r.repo, message: e instanceof Error ? e.message : String(e) })
			}
			sortProjects(result.projects)
			onRepo?.({ projects: [...result.projects], failed: [...result.failed] })
		}),
	)
	return result
}

async function projectsIn(gh: GitHub, r: Repo): Promise<GhProject[]> {
	const key = `projects:${r.owner}/${r.repo}`
	const known = await gh.cache.getJson<{ pushedAt: string; branch: string; paths: string[] }>(key)
	let paths: string[]
	if (known && known.pushedAt === r.pushedAt && known.branch === r.defaultBranch) paths = known.paths
	else {
		paths = (await gh.treeAtBranch(r, r.defaultBranch)).filter(p => extname(p) === ".prjpcb" && !isInSkippedDir(p))
		await gh.cache.putJson(key, { pushedAt: r.pushedAt, branch: r.defaultBranch, paths })
	}
	return paths.map(prjPath => ({ owner: r.owner, repo: r.repo, branch: r.defaultBranch, prjPath, name: stripExt(prjPath) }))
}

function sortProjects(ps: GhProject[]): void {
	ps.sort((a, b) => a.repo.localeCompare(b.repo) || a.prjPath.localeCompare(b.prjPath, undefined, { numeric: true, sensitivity: "base" }))
}
