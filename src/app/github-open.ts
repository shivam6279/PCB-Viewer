import { GitCommitSource } from "../github/commit-source"
import { GitHubError } from "../github/client"
import { formatRoute, parseRoute, type Route } from "../github/route"
import { currentGitHub, handleAuthError } from "../github/session"
import { dirname, extname, PathIndex, stripExt } from "../source/paths"
import { loadProject } from "../model/load-project"
import { workerParser } from "../parse/worker-parser"
import { useOpening, type Opening } from "./opening"
import { syncCompare } from "./compare"
import { addRecent } from "./recents"
import { useAppStore } from "./store"

// GitHub screens are driven by the URL hash: navigate() changes it, the hashchange listener in App
// calls applyRoute(). So Back/Forward, reloads and bookmarks all take the same path.
export function navigate(route: Route): void {
	const hash = formatRoute(route)
	if (location.hash === hash) void applyRoute(route)
	else location.hash = hash
}

export const currentRoute = (): Route => parseRoute(location.hash)

const onGitHubScreen = () => {
	const s = useAppStore.getState().screen
	return s.kind === "ghProject" || (s.kind === "viewer" && s.source instanceof GitCommitSource)
}

export async function applyRoute(route: Route): Promise<void> {
	const { setScreen } = useAppStore.getState()
	if (route.kind !== "ghCommit") cancelOpening()
	if (route.kind === "home") {
		if (onGitHubScreen()) setScreen({ kind: "start", error: null })
		return
	}
	if (route.kind === "ghProject") {
		setScreen({ kind: "ghProject", owner: route.owner, repo: route.repo, prjPath: route.prjPath, branch: route.branch, error: null })
		return
	}
	await openCommit(route)
}

// Double-click in the home tree: the branch head, resolved now, opened like any commit.
export async function openLatest(p: { owner: string; repo: string; prjPath: string; branch: string }): Promise<void> {
	const gh = currentGitHub()
	try {
		const head = await gh.head(p, p.branch)
		navigate({ kind: "ghCommit", owner: p.owner, repo: p.repo, sha: head.sha, prjPath: p.prjPath })
	} catch (e) {
		if (!handleAuthError(e)) useAppStore.getState().setScreen({ kind: "ghProject", owner: p.owner, repo: p.repo, prjPath: p.prjPath, branch: null, error: e instanceof Error ? e.message : String(e) })
	}
}

let openSeq = 0

// Whatever is still loading must not land once the user has gone somewhere else.
function cancelOpening(): void {
	openSeq++
	useOpening.setState({ opening: null })
}

async function openCommit(route: Extract<Route, { kind: "ghCommit" }>): Promise<void> {
	const gh = currentGitHub()
	const { setScreen, showProject } = useAppStore.getState()
	const prev = useAppStore.getState().screen
	const prevGit = prev.kind === "viewer" && prev.source instanceof GitCommitSource ? prev : null
	if (prevGit && prevGit.source instanceof GitCommitSource && prevGit.source.sha === route.sha && prevGit.project.prjPath === route.prjPath) {
		cancelOpening() // back to the commit on screen while another was still loading
		// Same commit, perhaps another comparison (Compare picked or closed).
		if (useAppStore.getState().compare?.sha !== (route.vs ?? undefined)) void syncCompare(prevGit.source, prevGit.project, route.vs)
		return
	}
	// The viewer parked behind the home screen is this commit: go back to it as it was.
	const parked = useAppStore.getState().parked
	if (parked && parked.source instanceof GitCommitSource && parked.source.sha === route.sha && parked.project.prjPath === route.prjPath) {
		cancelOpening()
		useAppStore.getState().returnToViewer()
		void syncCompare(parked.source, parked.project, route.vs)
		return
	}

	// Progress shows where the click happened: the project page's commit row or the viewer's commit
	// picker. Only a fresh deep link gets the full-page loading screen.
	const seq = ++openSeq
	const current = () => seq === openSeq
	const setOpening = (o: Opening | null) => current() && useOpening.setState({ opening: o })
	const prevProject = prev.kind === "ghProject" ? prev : null
	if (!prevProject && !prevGit) setScreen({ kind: "loading", label: `Opening ${stripExt(route.prjPath)} @ ${route.sha.slice(0, 7)}` })
	useOpening.setState({ opening: { sha: route.sha, done: 0, total: 0 }, error: null })

	const ref = { owner: route.owner, repo: route.repo }
	const folder = dirname(route.prjPath)
	const source = new GitCommitSource(gh, ref, route.sha, folder)
	try {
		source.onProgress = (done, total) => setOpening({ sha: route.sha, done, total })
		const files = await source.list()
		// The project file may have been renamed at this commit: take the folder's .PrjPcb then.
		const prj =
			new PathIndex(files).get(route.prjPath) ?? files.find(p => dirname(p).toLowerCase() === folder.toLowerCase() && extname(p) === ".prjpcb")
		if (!current()) return
		if (!prj) {
			const project = { kind: "ghProject", owner: route.owner, repo: route.repo, prjPath: route.prjPath, branch: null } as const
			history.replaceState(null, "", formatRoute(project))
			setScreen({ ...project, error: `${stripExt(route.prjPath)} isn't in commit ${route.sha.slice(0, 7)}` })
			return
		}
		const project = await loadProject(source, prj, workerParser())
		if (!current()) return // a later click won
		showProject(source, project)
		void syncCompare(source, project, route.vs)
		const now = useAppStore.getState().screen
		if (now.kind !== "viewer") return
		// Switching commits keeps the tab and the sheet, where the sheet still exists.
		if (prevGit && prevGit.project.prjPath === route.prjPath) {
			const sheetStill = prevGit.activeSheetId !== null && hasNode(now.project.hierarchy, prevGit.activeSheetId)
			const tab = prevGit.tab === "sch" && !sheetStill ? now.tab : prevGit.tab
			useAppStore.setState({ screen: { ...now, tab, activeSheetId: sheetStill ? prevGit.activeSheetId : now.activeSheetId } })
		}
		await addRecent({ name: now.project.name, github: { owner: route.owner, repo: route.repo, sha: route.sha, prjPath: route.prjPath }, openedAt: Date.now() }).catch(() => {})
	} catch (e) {
		if (!current()) return
		if (handleAuthError(e)) return setScreen({ kind: "start", error: null })
		const message =
			e instanceof GitHubError && (e.kind === "notFound" || e.kind === "forbidden")
				? `No access to ${route.owner}/${route.repo} — if your token is limited to selected repositories, add this one`
				: e instanceof Error
					? e.message
					: String(e)
		// From the viewer it stays on the commit that was open; the commit picker shows the error.
		if (prevGit) useOpening.setState({ opening: null, error: message })
		else if (prevProject) setScreen({ ...prevProject, error: message })
		else setScreen({ kind: "start", error: message })
	} finally {
		// The viewer keeps reading files (the board, 3D models) after this; that isn't "opening".
		source.onProgress = null
		if (current()) useOpening.setState({ opening: null })
	}
}

function hasNode(nodes: { id: string; children: { id: string; children: unknown[] }[] }[], id: string): boolean {
	return nodes.some(n => n.id === id || hasNode(n.children as typeof nodes, id))
}
