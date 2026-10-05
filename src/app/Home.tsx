import { ArrowRight, ChevronDown, ChevronRight, FileArchive, FolderOpen, LogIn, LogOut, RefreshCw, Search, Upload, X } from "lucide-react"
import { GitCommitSource } from "../github/commit-source"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ancestorsOf, buildProjectTree, filterTree, projectKey, type TreeNode } from "../github/project-tree"
import { useSession } from "../github/session"
import { REPOS } from "../github/config"
import { DirectoryHandleSource } from "../source/directory-handle-source"
import { sourceFromDrop } from "../source/drop"
import { zipSource } from "../source/zip-source"
import { navigate, openLatest } from "./github-open"
import { guarded, openRecent, openSource } from "./open"
import { ProjectDetails } from "./ProjectDetails"
import { isGitRecent, listRecents, recentKey, type Recent } from "./recents"
import { Spinner } from "./Spinner"
import { useAppStore, type ViewerScreen } from "./store"
import { useGitHubProjects } from "./use-github-projects"

export const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new"
const EXPANDED_KEY = "home-tree-open"

// The start screen, laid out like the viewer: top bar, a project tree on the left (recent projects,
// then the GitHub repos as their folders nest), and the selected project or a drop zone on the right.
export function Home() {
	const screen = useAppStore(s => s.screen)
	const session = useSession(s => s.session)
	const signedIn = session.status === "signedIn" ? session : null
	// Public projects need no sign-in; signing in is only for private repos or a higher limit.
	const projects = useGitHubProjects(session.gh, session.owner)
	const [showSignIn, setShowSignIn] = useState(false)
	const anonError = session.status === "anonymous" ? session.error : null
	const limited = !signedIn && /rate limit/i.test(projects.error ?? "")
	const [query, setQuery] = useState("")
	const [recents, setRecents] = useState<Recent[]>([])
	const [dragging, setDragging] = useState(false)
	const search = useRef<HTMLInputElement>(null)
	const zipInput = useRef<HTMLInputElement>(null)
	const canPickFolder = typeof window !== "undefined" && "showDirectoryPicker" in window
	const selected = screen.kind === "ghProject" ? screen : null
	const parked = useAppStore(s => s.parked)

	useEffect(() => {
		listRecents().then(setRecents, () => setRecents([]))
	}, [])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
				e.preventDefault()
				search.current?.focus()
			}
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [])

	const pickFolder = async () => {
		if (!window.showDirectoryPicker) return
		const handle = await window.showDirectoryPicker({ mode: "read" }).catch(() => undefined) // user cancelled
		if (handle) await guarded(() => openSource(new DirectoryHandleSource(handle), handle))
	}
	const openZip = async (file: File | undefined) => {
		if (file) await guarded(async () => openSource(zipSource(file.name, new Uint8Array(await file.arrayBuffer())), null))
	}

	return (
		<div
			className={`home${dragging ? " dragging" : ""}`}
			onDragOver={e => {
				e.preventDefault()
				setDragging(true)
			}}
			onDragLeave={e => {
				if (e.currentTarget === e.target) setDragging(false)
			}}
			onDrop={async e => {
				e.preventDefault()
				setDragging(false)
				await guarded(async () => {
					const dropped = await sourceFromDrop(e.dataTransfer)
					if (dropped) await openSource(dropped.source, dropped.handle)
				})
			}}
		>
			<header className="home-topbar">
				<div className="home-brand">
					<span className="home-logo" aria-hidden />
					<div>
						<div className="home-brand-name">PCB-Viewer</div>
						<div className="dim">GitHub · {REPOS.map(r => `${session.owner}/${r}`).join(", ")}</div>
					</div>
				</div>
				<label className="topbar-search home-search">
					<Search size={16} />
					<input ref={search} aria-label="Search projects" placeholder="Search projects" value={query} onChange={e => setQuery(e.target.value)} />
					<span className="kbd">Ctrl+K</span>
				</label>
				<div className="home-actions">
					{parked && (
						<button className="btn primary" onClick={() => returnTo(parked)}>
							Return to {parked.project.name} <ArrowRight size={15} />
						</button>
					)}
					{canPickFolder && (
						<button className="btn ghost" onClick={pickFolder}>
							<FolderOpen size={15} /> Open folder…
						</button>
					)}
					<button className="btn ghost" onClick={() => zipInput.current?.click()}>
						<FileArchive size={15} /> Open .zip…
					</button>
					<input ref={zipInput} data-testid="zip-input" type="file" accept=".zip" hidden onChange={e => openZip(e.target.files?.[0])} />
					{signedIn ? (
						<Account login={signedIn.login} />
					) : (
						<button className="btn ghost" aria-pressed={showSignIn} onClick={() => setShowSignIn(!showSignIn)}>
							<LogIn size={15} /> Sign in
						</button>
					)}
				</div>
			</header>

			<nav className="sidebar home-sidebar" aria-label="Projects">
				{parked && <OpenProject parked={parked} />}
				{recents.length > 0 && !query && <RecentList recents={recents.slice(0, 5)} />}
				<div className="section-heading with-action">
					<span>GITHUB</span>
					<button className="icon-btn" aria-label="Refresh" onClick={projects.refresh} disabled={projects.loading}>
						<RefreshCw size={13} className={projects.loading ? "spin" : undefined} />
					</button>
				</div>
				{!projects.discovery && projects.loading && (
					<div className="sidebar-note dim">
						<Spinner /> Looking for projects…
					</div>
				)}
				{projects.error && (
					<div className="sidebar-note error">
						{projects.error}
						{limited && " — GitHub limits visitors without sign-in; sign in for more."}
					</div>
				)}
				{projects.discovery && (
					<ProjectTreeView
						projects={projects.discovery.projects}
						query={query}
						selectedKey={selected ? projectKey(selected) : null}
					/>
				)}
				{projects.discovery?.failed.map(f => (
					<div key={f.repo} className="sidebar-note error">
						{f.repo}: {f.message}
					</div>
				))}
			</nav>

			<main className="home-main">
				{screen.kind === "start" && screen.error && (
					<div className="banner error" role="alert">
						{screen.error}
					</div>
				)}
				{screen.kind === "loading" && (
					<div className="banner" role="status">
						<Spinner /> {screen.label}
					</div>
				)}
				{(showSignIn || anonError || limited) && !signedIn && <GitHubConnect onClose={() => setShowSignIn(false)} />}
				{selected ? (
					<ProjectDetails gh={session.gh} project={selected} />
				) : (
					<Welcome
						owner={session.owner}
						projectCount={projects.discovery?.projects.length ?? null}
						dragging={dragging}
						onPick={canPickFolder ? pickFolder : () => zipInput.current?.click()}
					/>
				)}
			</main>
		</div>
	)
}

// Back to the viewer left for this screen, as it was. A GitHub commit goes through its URL.
function returnTo(parked: ViewerScreen): void {
	const src = parked.source
	if (src instanceof GitCommitSource) navigate({ kind: "ghCommit", owner: src.ref.owner, repo: src.ref.repo, sha: src.sha, prjPath: parked.project.prjPath ?? "" })
	else useAppStore.getState().returnToViewer()
}

function OpenProject({ parked }: { parked: ViewerScreen }) {
	const src = parked.source
	return (
		<>
			<div className="section-heading">OPEN</div>
			<div className="tree-row active" style={{ paddingLeft: 8 }} role="button" aria-label={`Return to ${parked.project.name}`} onClick={() => returnTo(parked)}>
				<span className="tree-chevron" />
				<span className="tree-icon pcb" />
				<span className="tree-label">{parked.project.name}</span>
				<span className="tree-meta dim">{src instanceof GitCommitSource ? `${src.ref.repo} @ ${src.sha.slice(0, 7)}` : src.name}</span>
			</div>
		</>
	)
}

function Account({ login }: { login: string }) {
	const signOut = useSession(s => s.signOut)
	return (
		<div className="account">
			<span className="avatar" aria-hidden>
				{login.slice(0, 1).toUpperCase()}
			</span>
			<span className="account-name">{login}</span>
			<button className="icon-btn" aria-label="Sign out" onClick={() => signOut()}>
				<LogOut size={15} />
			</button>
		</div>
	)
}

function RecentList({ recents }: { recents: Recent[] }) {
	return (
		<>
			<div className="section-heading">RECENT</div>
			{recents.map(r => (
				<div
					key={recentKey(r)}
					className="tree-row"
					style={{ paddingLeft: 8 }}
					role="button"
					onClick={() => (isGitRecent(r) ? navigate({ kind: "ghCommit", ...r.github }) : openRecent(r))}
				>
					<span className="tree-chevron" />
					<span className="tree-icon pcb" />
					<span className="tree-label">{r.name}</span>
					<span className="tree-meta dim">{isGitRecent(r) ? `${r.github.repo} @ ${r.github.sha.slice(0, 7)}` : r.handle.name}</span>
				</div>
			))}
		</>
	)
}

// Only what the user opened or closed is remembered; anything else takes its default (repos open,
// folders closed), so a repo that turns up later — the list arrives repo by repo — still opens.
function loadToggles(): Record<string, boolean> {
	try {
		return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}") as Record<string, boolean>
	} catch {
		return {}
	}
}

function ProjectTreeView({ projects, query, selectedKey }: { projects: Parameters<typeof buildProjectTree>[0]; query: string; selectedKey: string | null }) {
	const tree = useMemo(() => buildProjectTree(projects), [projects])
	// Repos start open; folders below them closed, except on the way to the selected project.
	const [toggles, setToggles] = useState<Record<string, boolean>>(loadToggles)
	const repoKeys = useMemo(() => new Set(tree.map(r => r.key)), [tree])
	const isOpen = (key: string) => toggles[key] ?? repoKeys.has(key)
	const save = (next: Record<string, boolean>) => {
		setToggles(next)
		try {
			localStorage.setItem(EXPANDED_KEY, JSON.stringify(next))
		} catch {
			// storage blocked: this session only
		}
	}

	useEffect(() => {
		if (!selectedKey) return
		const path = ancestorsOf(tree, selectedKey)
		if (path && path.some(k => !isOpen(k))) save({ ...toggles, ...Object.fromEntries(path.map(k => [k, true])) })
	}, [selectedKey, tree])

	const filtering = query.trim() !== ""
	const shown = filtering ? filterTree(tree, query) : tree
	const toggle = (key: string) => save({ ...toggles, [key]: !isOpen(key) })

	const rows = (nodes: TreeNode[], depth: number): ReactNode[] =>
		nodes.flatMap(n => {
			const pad = { paddingLeft: 8 + depth * 18 }
			if (n.kind === "project") {
				const p = n.project
				return [
					<div
						key={n.key}
						className={`tree-row${n.key === selectedKey ? " active" : ""}`}
						style={pad}
						role="treeitem"
						aria-selected={n.key === selectedKey}
						onClick={() => navigate({ kind: "ghProject", owner: p.owner, repo: p.repo, prjPath: p.prjPath, branch: null })}
						onDoubleClick={() => void openLatest(p)}
					>
						<span className="tree-chevron" />
						<span className="tree-icon pcb" />
						<span className="tree-label">{n.label}</span>
						{n.label.toLowerCase() !== p.name.toLowerCase() && <span className="tree-meta dim">{p.name}</span>}
					</div>,
				]
			}
			const open = filtering || isOpen(n.key)
			return [
				<div key={n.key} className="tree-row" style={pad} role="treeitem" aria-expanded={open} onClick={() => toggle(n.key)}>
					<span className="tree-chevron">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
					<span className={`tree-icon ${repoKeys.has(n.key) ? "repo" : "folder"}`} />
					<span className="tree-label">{n.label}</span>
				</div>,
				...(open ? rows(n.children, depth + 1) : []),
			]
		})

	if (filtering && shown.length === 0) return <div className="sidebar-note dim">No projects match “{query.trim()}”</div>
	// One repo: its folders are the top level (a lone repo row adds a level and says nothing).
	const top = shown.length === 1 && shown[0]!.kind === "folder" ? shown[0]!.children : shown
	return (
		<div role="tree" aria-label="GitHub projects">
			{rows(top, 0)}
		</div>
	)
}

function Welcome(props: { owner: string; projectCount: number | null; dragging: boolean; onPick(): void }) {
	return (
		<div className="welcome">
			<button className={`dropzone${props.dragging ? " over" : ""}`} onClick={props.onPick}>
				<Upload size={28} strokeWidth={1.5} />
				<span className="dropzone-title">Drop an Altium project folder or .zip here</span>
				<span className="dim">or click to choose a folder</span>
			</button>
			{props.projectCount !== null && (
				<p className="welcome-hint dim">
					{props.projectCount} {props.projectCount === 1 ? "project" : "projects"} on GitHub — pick one on the left to see its history.
				</p>
			)}
			<p className="welcome-legal dim">An independent viewer for Altium Designer files. Not affiliated with or endorsed by Altium Limited.</p>
		</div>
	)
}

// Optional: public projects show without it. A token adds private repos and lifts GitHub's limit.
function GitHubConnect({ onClose }: { onClose(): void }) {
	const session = useSession(s => s.session)
	const signIn = useSession(s => s.signIn)
	const [token, setToken] = useState("")
	const checking = session.status === "checking"
	const error = session.status === "anonymous" ? session.error : null
	return (
		<section className="card sign-in-card" aria-label="GitHub">
			<div className="card-title">
				Sign in to GitHub
				<button className="icon-btn" aria-label="Close sign-in" onClick={onClose}>
					<X size={15} />
				</button>
			</div>
			<p className="dim">
				Not needed: the repository is public. GitHub allows a visitor 60 requests an hour without one; a token lifts that. Paste a fine-grained token with <b>Contents</b>{" "}
				and <b>Metadata</b> set to read-only —{" "}
				<a href={TOKEN_URL} target="_blank" rel="noreferrer">
					create one on GitHub
				</a>
				.
			</p>
			<form
				className="card-row"
				onSubmit={async e => {
					e.preventDefault()
					if (await signIn(token)) {
						setToken("")
						onClose()
					}
				}}
			>
				<input className="field" type="password" aria-label="GitHub token" placeholder="github_pat_…" value={token} autoComplete="off" spellCheck={false} onChange={e => setToken(e.target.value)} />
				<button className="btn primary" type="submit" disabled={checking || !token.trim()}>
					{checking && <Spinner />}
					{checking ? "Checking…" : "Connect GitHub"}
				</button>
			</form>
			{error && (
				<div className="banner error" role="alert">
					{error}
				</div>
			)}
		</section>
	)
}
