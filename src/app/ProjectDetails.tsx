import { ChevronRight, GitBranch } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { GitCommitSource } from "../github/commit-source"
import type { CommitInfo, GitHub } from "../github/github"
import { ProjectHistory, projectFolders } from "../github/history"
import { handleAuthError } from "../github/session"
import { workerParser } from "../parse/worker-parser"
import { dirname, stripExt } from "../source/paths"
import { formatDate } from "./format-date"
import { navigate } from "./github-open"
import { openingLabel, useOpening } from "./opening"
import { Spinner } from "./Spinner"

interface Loaded {
	branch: string
	branches: string[]
	head: CommitInfo
	history: ProjectHistory
}

export interface ProjectRef {
	owner: string
	repo: string
	prjPath: string
	branch: string | null
	error: string | null
}

// The home screen's main area for a selected GitHub project: where it lives, its branch, and its history.
export function ProjectDetails({ gh, project }: { gh: GitHub; project: ProjectRef }) {
	return <Details key={`${project.owner}/${project.repo}/${project.prjPath}/${project.branch}`} gh={gh} {...project} />
}

function Details(props: { gh: GitHub } & ProjectRef) {
	const { gh, owner, repo, prjPath } = props
	const ref = { owner, repo }
	const [loaded, setLoaded] = useState<Loaded | null>(null)
	const [commits, setCommits] = useState<CommitInfo[]>([])
	const [busy, setBusy] = useState(true)
	const [error, setError] = useState<string | null>(props.error)
	const live = useRef(true)
	const opening = useOpening(s => s.opening)

	const fail = (e: unknown) => {
		if (!live.current || handleAuthError(e)) return
		setError(e instanceof Error ? e.message : String(e))
	}

	useEffect(() => {
		live.current = true
		;(async () => {
			const branch = props.branch ?? (await gh.repoInfo(ref)).defaultBranch
			const [branches, head] = await Promise.all([gh.branches(ref), gh.head(ref, branch)])
			const folders = await historyFolders(gh, ref, head.sha, prjPath)
			const history = ProjectHistory.forRepo(gh, ref, branch, folders)
			const first = await history.loadMore()
			if (!live.current) return
			setLoaded({ branch, branches, head, history })
			setCommits(first)
		})()
			.catch(fail)
			.finally(() => live.current && setBusy(false))
		return () => {
			live.current = false
		}
	}, [])

	const more = async () => {
		if (!loaded) return
		setBusy(true)
		try {
			const next = await loaded.history.loadMore()
			if (live.current) setCommits(c => [...c, ...next])
		} catch (e) {
			fail(e)
		} finally {
			if (live.current) setBusy(false)
		}
	}

	const open = (sha: string) => navigate({ kind: "ghCommit", owner, repo, sha, prjPath })
	const crumbs = [repo, ...dirname(prjPath).split("/").filter(Boolean)]
	const openingLatest = loaded !== null && opening?.sha === loaded.head.sha && !commits.some(c => c.sha === opening.sha)

	return (
		<section className="details" aria-label="Project">
			<header className="details-head">
				<div className="details-title">
					<span className="tree-icon pcb" />
					<h2>{stripExt(prjPath)}</h2>
				</div>
				<div className="details-crumbs dim">
					{crumbs.map((c, i) => (
						<span key={i}>
							{i > 0 && <ChevronRight size={12} />}
							{c}
						</span>
					))}
				</div>
				<div className="details-actions">
					{loaded && (
						<label className="select-field">
							<GitBranch size={14} />
							<select aria-label="Branch" value={loaded.branch} onChange={e => navigate({ kind: "ghProject", owner, repo, prjPath, branch: e.target.value })}>
								{loaded.branches.map(b => (
									<option key={b}>{b}</option>
								))}
							</select>
						</label>
					)}
					<button className="btn primary" disabled={!loaded} onClick={() => loaded && open(loaded.head.sha)}>
						{openingLatest && <Spinner />}
						Open latest
					</button>
				</div>
			</header>
			{error && <div className="banner error">{error}</div>}
			<div className="section-heading">HISTORY</div>
			<div className="commit-table" role="list" aria-label="Commits">
				<div className="commit-row head" aria-hidden>
					<span>Message</span>
					<span>Author</span>
					<span>Date</span>
					<span>Commit</span>
				</div>
				{commits.map(c => {
					const here = opening?.sha === c.sha
					return (
						<button key={c.sha} role="listitem" className={`commit-row${here ? " opening" : ""}`} aria-busy={here} onClick={() => open(c.sha)}>
							<span className="commit-msg">{c.message}</span>
							<span className="dim">{c.author}</span>
							<span className="dim">{formatDate(c.date)}</span>
							{here ? (
								<span className="gh-opening" role="status">
									<Spinner /> {openingLabel(opening)}
								</span>
							) : (
								<code className="dim">{c.sha.slice(0, 7)}</code>
							)}
						</button>
					)
				})}
			</div>
			{busy && (
				<div className="details-status dim">
					<Spinner /> Loading history…
				</div>
			)}
			{!busy && loaded && commits.length === 0 && <div className="details-status dim">No commits touch this project on {loaded.branch}</div>}
			{!busy && loaded?.history.hasMore && (
				<button className="btn load-more" onClick={more}>
					Load more
				</button>
			)}
		</section>
	)
}

// The history covers the project's folder plus folders it borrows documents from. That is fixed for a
// commit, so it is cached by sha: coming back here doesn't wait on the parse worker (busy compiling
// the commit just left).
async function historyFolders(gh: GitHub, ref: { owner: string; repo: string }, sha: string, prjPath: string): Promise<string[]> {
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
