import { ArrowRight, ChevronRight, GitBranch } from "lucide-react"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import type { ChangedFile, CommitDetails, CommitInfo, GitHub } from "../github/github"
import { ProjectHistory } from "../github/history"
import { handleAuthError } from "../github/session"
import { dirname, stripExt } from "../source/paths"
import { formatDate } from "./format-date"
import { navigate } from "./github-open"
import { openingLabel, useOpening } from "./opening"
import { historyFolders } from "./project-history"
import { previewManifest, storedPreview, type BoardPreview, type BoardStats } from "./stored-preview"
import { Spinner } from "./Spinner"
import { ProjectIcon } from "./tree-icons"

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
	const [expanded, setExpanded] = useState<string | null>(null) // the commit opened up below its row
	// The deploy's list of each project's picture commit and history folders (null: none published).
	const manifest = useMemo(() => previewManifest(ref), [])
	const [previewSha, setPreviewSha] = useState<string | null>(null)
	const [preview, setPreview] = useState<PreviewState>("loading")
	// The page shows all at once: a placeholder until the history and the picture are both in (the
	// picture found, absent, or being drawn), or REVEAL_MS at the most.
	const [revealed, setRevealed] = useState(false)

	const fail = (e: unknown) => {
		if (!live.current || handleAuthError(e)) return
		setError(e instanceof Error ? e.message : String(e))
	}

	useEffect(() => {
		live.current = true
		;(async () => {
			const branch = props.branch ?? (await gh.repoInfo(ref)).defaultBranch
			const [branches, head, m] = await Promise.all([gh.branches(ref), gh.head(ref, branch), manifest])
			// The published list holds the folders as of the branch head it was made at: still right while
			// that is the head (it saves reading the project file).
			const listed = m && m.branch === branch && m.head === head.sha ? m.projects[prjPath] : undefined
			const folders = listed?.folders ?? (await historyFolders(gh, ref, head.sha, prjPath))
			const history = ProjectHistory.forRepo(gh, ref, branch, folders)
			const first = await history.loadMore()
			if (!live.current) return
			setLoaded({ branch, branches, head, history })
			setCommits(first)
			if (first[0]) setPreviewSha(first[0].sha)
			else setPreview(null)
		})()
			.catch(fail)
			.finally(() => live.current && setBusy(false))
		return () => {
			live.current = false
		}
	}, [])

	// The published picture asked for at once, by the list's commit for it, alongside the history: by the
	// time the history says which commit it is, it is usually in.
	useEffect(() => {
		void manifest.then(m => {
			const listed = m?.projects[prjPath]
			if (listed) void storedPreview(ref, listed.sha, prjPath)
		})
		const t = setTimeout(() => live.current && setRevealed(true), REVEAL_MS)
		return () => clearTimeout(t)
	}, [])

	// The picture at the newest commit touching the project: the published one, else drawn here.
	useEffect(() => {
		if (!previewSha) return
		let on = true
		let abandon = () => {}
		setPreview("loading")
		;(async () => {
			const stored = await storedPreview(ref, previewSha, prjPath)
			if (!on) return
			if (stored !== undefined) return setPreview(stored)
			setPreview("drawing")
			const m = await import("../3d/board-preview")
			if (!on) return
			abandon = () => m.abandonBoardPreview(ref, previewSha, prjPath)
			const drawn = await m.drawBoardPreview(gh, ref, previewSha, prjPath)
			if (on) setPreview(drawn)
		})().catch(e => {
			if (on && !(e instanceof Error && e.name === "PreviewAbandoned")) setPreview({ error: e instanceof Error ? e.message : String(e) })
		})
		return () => {
			on = false
			abandon()
		}
	}, [previewSha])

	useEffect(() => {
		if (!revealed && ((loaded && preview !== "loading") || (!busy && !loaded))) setRevealed(true)
	}, [loaded, preview, busy, revealed])

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
					<ProjectIcon />
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
			{!revealed ? (
				<Placeholder />
			) : (
			<div className="details-body">
			{preview !== null && <Preview preview={preview} prjPath={prjPath} />}
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
					const isOpen = expanded === c.sha
					return (
						<Fragment key={c.sha}>
						<button
							role="listitem"
							className={`commit-row${here ? " opening" : ""}${isOpen ? " expanded" : ""}`}
							aria-busy={here}
							aria-expanded={isOpen}
							onClick={() => setExpanded(isOpen ? null : c.sha)}
							onDoubleClick={() => open(c.sha)}
						>
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
						{isOpen && <CommitDetailsPanel gh={gh} owner={owner} repo={repo} sha={c.sha} folders={loaded?.history.folders ?? [dirname(prjPath)]} onOpen={() => open(c.sha)} />}
						</Fragment>
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
			</div>
			)}
		</section>
	)
}

// A commit opened up in the history: its whole message, who and when, and the files it changed (the
// project's own first, the rest of the repo's after). Open shows it in the viewer, as a double-click does.
function CommitDetailsPanel({ gh, owner, repo, sha, folders, onOpen }: { gh: GitHub; owner: string; repo: string; sha: string; folders: string[]; onOpen(): void }) {
	const [details, setDetails] = useState<CommitDetails | { error: string } | null>(null)
	useEffect(() => {
		let live = true
		gh.commitDetails({ owner, repo }, sha).then(
			d => live && setDetails(d),
			e => {
				if (live && !handleAuthError(e)) setDetails({ error: e instanceof Error ? e.message : String(e) })
			},
		)
		return () => {
			live = false
		}
	}, [sha])
	const inProject = (f: ChangedFile) => folders.some(d => d === "" || f.path.toLowerCase().startsWith(`${d.toLowerCase()}/`))
	const files = details && "files" in details ? details.files : []
	const mine = files.filter(inProject), others = files.filter(f => !inProject(f))
	return (
		<div className="commit-details">
			{!details ? (
				<div className="dim">
					<Spinner /> Loading the commit…
				</div>
			) : "error" in details ? (
				<div className="error">{details.error}</div>
			) : (
				<>
					<div className="commit-details-head">
						<div className="commit-details-message">
							<div className="subject">{details.message}</div>
							{details.body && <div className="body">{details.body}</div>}
						</div>
						<button className="btn primary" onClick={onOpen}>
							Open in viewer <ArrowRight size={15} />
						</button>
					</div>
					<div className="commit-details-meta dim">
						{details.author} · {new Date(details.date).toLocaleString()} · <code>{details.sha}</code>
					</div>
					<ChangedFiles title={`Changed in this project · ${mine.length}`} files={mine} strip={folders.length === 1 ? folders[0]! : ""} />
					{others.length > 0 && <ChangedFiles title={`Elsewhere in the repo · ${others.length}`} files={others} strip="" collapsed />}
				</>
			)}
		</div>
	)
}

const STATUS_LETTER: Record<ChangedFile["status"], string> = { added: "A", modified: "M", removed: "D", renamed: "R" }

function ChangedFiles({ title, files, strip, collapsed }: { title: string; files: ChangedFile[]; strip: string; collapsed?: boolean }) {
	const [open, setOpen] = useState(!collapsed)
	const short = (p: string) => (strip && p.toLowerCase().startsWith(`${strip.toLowerCase()}/`) ? p.slice(strip.length + 1) : p)
	return (
		<div className="commit-files">
			<button className="commit-files-title" aria-expanded={open} onClick={() => setOpen(!open)}>
				<ChevronRight size={13} className="chevron" />
				{title}
			</button>
			{open && (
				<ul>
					{files.length === 0 && <li className="dim">None</li>}
					{files.map(f => (
						<li key={f.path}>
							<span className={`file-status ${f.status}`}>{STATUS_LETTER[f.status]}</span>
							<span className="file-path">
								{f.previous && <span className="dim">{short(f.previous)} → </span>}
								{short(f.path)}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

type PreviewState = BoardPreview | null | "loading" | "drawing" | { error: string }

const REVEAL_MS = 1200 // the longest the page waits to show everything at once

// What the page shows until its history and picture are in: the same shapes, empty.
function Placeholder() {
	return (
		<div className="details-placeholder" aria-busy="true" aria-label="Loading">
			<div className="board-card">
				<div className="board-card-image skeleton" style={{ width: 200, height: 170 }} />
				<div className="board-card-facts">
					<div className="skeleton" style={{ width: 190, height: 28 }} />
					<div className="skeleton" style={{ width: 230, height: 24 }} />
					<div className="skeleton" style={{ width: 260, height: 40 }} />
				</div>
			</div>
			<div className="section-heading">HISTORY</div>
			<div className="commit-table">
				{[0, 1, 2, 3].map(i => (
					<div key={i} className="commit-row skeleton-row">
						<span className="skeleton" />
						<span className="skeleton" />
						<span className="skeleton" />
						<span className="skeleton" />
					</div>
				))}
			</div>
		</div>
	)
}

// The board as of the newest commit touching the project, a thumbnail of its top: the one the site
// publishes, else drawn here in the browser (the whole project is loaded to draw it).
function Preview({ preview, prjPath }: { preview: Exclude<PreviewState, null>; prjPath: string }) {
	const ready = typeof preview === "object" && !("error" in preview) ? preview : null
	const waiting = preview === "loading" || preview === "drawing"
	return (
		<div className="board-card">
			<div className={`board-card-image ${ready?.backdrop ?? "light"}`}>
				{waiting ? <Spinner /> : ready ? <img src={ready.image} alt={`${stripExt(prjPath)} board, top`} /> : <span>No preview</span>}
			</div>
			<div className="board-card-facts">
				{ready ? (
					<BoardFacts stats={ready.stats} mask={ready.mask} />
				) : (
					<div className="dim">{waiting ? "Rendering the board…" : typeof preview === "object" && "error" in preview ? preview.error : ""}</div>
				)}
			</div>
		</div>
	)
}

function BoardFacts({ stats: s, mask }: { stats: BoardStats; mask: string }) {
	const mm = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1))
	const parts = s.components.top + s.components.bottom
	const counts: [string, number][] = [
		["Components", parts],
		["Nets", s.nets],
		["Vias", s.vias],
	]
	return (
		<>
			<div className="board-size">
				{mm(s.width)} <span className="times">×</span> {mm(s.height)}
				<span className="unit">mm</span>
			</div>
			<div className="board-tags">
				<span className="tag">{s.copperLayers}-layer</span>
				<span className="tag">{s.thickness.toFixed(2)} mm</span>
				<span className="tag">
					<span className="swatch" style={{ background: mask }} />
					Mask
				</span>
			</div>
			<div className="board-counts">
				{counts.map(([label, n]) => (
					<div key={label}>
						<div className="count">{n.toLocaleString()}</div>
						<div className="label">{label}</div>
					</div>
				))}
			</div>
		</>
	)
}
