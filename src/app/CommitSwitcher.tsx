import { GitCompareArrows, X } from "lucide-react"
import { useEffect, useState } from "react"
import { GitCommitSource } from "../github/commit-source"
import type { CommitInfo } from "../github/github"
import { foldersOf, ProjectHistory } from "../github/history"
import { navigate } from "./github-open"
import { handleAuthError } from "../github/session"
import type { ProjectSummary } from "../model/load-project"
import { formatDate } from "./format-date"
import { openingLabel, useOpening } from "./opening"
import { Spinner } from "./Spinner"
import { useAppStore } from "./store"

// The viewer's commit pickers: the open (primary) commit, and with Compare a second one to compare it
// with. Both list the project's history on the repo's default branch, plus any commit open that isn't
// on it.
export function CommitSwitcher({ source, project }: { source: GitCommitSource; project: ProjectSummary }) {
	const [known, setKnown] = useState<CommitInfo[]>([])
	const [commits, setCommits] = useState<CommitInfo[]>([])
	const [history, setHistory] = useState<ProjectHistory | null>(null)
	const opening = useOpening(s => s.opening)
	const error = useOpening(s => s.error)
	const compare = useAppStore(s => s.compare)
	const prjPath = project.prjPath ?? ""
	const docPaths = project.documents.map(d => d.path).join("\n")
	const vs = compare?.sha ?? null

	// The open commits' own details, in case they are off the listed history.
	useEffect(() => {
		let live = true
		Promise.all([source.sha, vs].filter((s): s is string => s !== null).map(s => source.gh.commit(source.ref, s))).then(cs => live && setKnown(cs), handleAuthError)
		return () => {
			live = false
		}
	}, [source, vs])

	useEffect(() => {
		let live = true
		;(async () => {
			const repo = await source.gh.repoInfo(source.ref)
			const h = ProjectHistory.forRepo(source.gh, source.ref, repo.defaultBranch, foldersOf(prjPath, docPaths.split("\n")))
			const first = await h.loadMore()
			if (!live) return
			setHistory(h)
			setCommits(first)
		})().catch(handleAuthError)
		return () => {
			live = false
		}
	}, [source.gh, source.ref.owner, source.ref.repo, prjPath, docPaths])

	const list = [...known.filter(k => !commits.some(c => c.sha === k.sha)), ...commits]
	const go = (sha: string, other: string | null) => navigate({ kind: "ghCommit", owner: source.ref.owner, repo: source.ref.repo, sha, prjPath, vs: other })
	const more = async () => setCommits([...commits, ...((await history?.loadMore()) ?? [])])
	// Compare with the commit before the open one in the project's history (else the next newer one).
	const startCompare = () => {
		const i = list.findIndex(c => c.sha === source.sha)
		const other = list[i + 1] ?? list[i - 1]
		if (other) go(source.sha, other.sha)
	}
	const picker = (label: string, value: string, onPick: (sha: string) => void) => (
		<select
			aria-label={label}
			aria-busy={label === "Commit" && opening !== null}
			value={value}
			onChange={e => (e.target.value === "more" ? void more() : onPick(e.target.value))}
		>
			{!list.some(c => c.sha === value) && <option value={value}>{value.slice(0, 7)}</option>}
			{list.map(c => (
				<option key={c.sha} value={c.sha}>
					{`${c.sha.slice(0, 7)} · ${formatDate(c.date)} · ${c.message}`}
				</option>
			))}
			{history?.hasMore && <option value="more">Older commits…</option>}
		</select>
	)

	return (
		<div className={`commit-switcher${vs ? " comparing" : ""}`}>
			{opening && (
				<span className="gh-opening" role="status">
					<Spinner /> {opening.sha.slice(0, 7)} · {openingLabel(opening)}
				</span>
			)}
			{!opening && error && (
				<span className="gh-switch-error" role="alert">
					{error}
				</span>
			)}
			{vs && <span className="switch-tag primary">A</span>}
			{picker("Commit", opening?.sha ?? source.sha, sha => go(sha, vs))}
			{vs ? (
				<>
					<span className="switch-tag secondary">B</span>
					{picker("Compare with", vs, sha => go(source.sha, sha))}
					{compare && compare.data.status === "loading" && !compare.error && <Spinner />}
					<button className="icon-btn" aria-label="Stop comparing" onClick={() => go(source.sha, null)}>
						<X size={15} />
					</button>
				</>
			) : (
				<button className="btn ghost" onClick={startCompare} disabled={list.length < 2}>
					<GitCompareArrows size={15} /> Compare
				</button>
			)}
		</div>
	)
}
