import { findLooseDocuments, findProjects, loadProject } from "../model/load-project"
import type { Parser } from "../parse/parser"
import { workerParser } from "../parse/worker-parser"
import { basename } from "../source/paths"
import type { ProjectSource } from "../source/types"
import { DirectoryHandleSource } from "../source/directory-handle-source"
import { addRecent, ensureReadPermission, type RecentProject } from "./recents"
import { useAppStore } from "./store"

// Local folders and zips have no URL; opening one leaves a GitHub URL behind so Back returns to it.
function leaveGitHubRoute(): void {
	if (typeof location !== "undefined" && location.hash.startsWith("#/gh/")) history.pushState(null, "", "#/")
}

export async function openSource(source: ProjectSource, handle: FileSystemDirectoryHandle | null, parser: Parser = workerParser()): Promise<void> {
	const { setScreen } = useAppStore.getState()
	leaveGitHubRoute()
	try {
		setScreen({ kind: "loading", label: `Scanning ${source.name}…` })
		const projects = await findProjects(source)
		if (projects.length === 1) return await openProject(source, handle, projects[0]!, parser)
		if (projects.length > 1) return setScreen({ kind: "pick", source, handle, projects })
		if ((await findLooseDocuments(source)).length > 0) return await openProject(source, handle, null, parser)
		setScreen({ kind: "start", error: `No Altium project or documents found in "${source.name}"` })
	} catch (e) {
		setScreen({ kind: "start", error: e instanceof Error ? e.message : String(e) })
	}
}

export async function openProject(
	source: ProjectSource,
	handle: FileSystemDirectoryHandle | null,
	prjPath: string | null,
	parser: Parser = workerParser(),
): Promise<void> {
	const { setScreen, showProject } = useAppStore.getState()
	try {
		setScreen({ kind: "loading", label: `Opening ${prjPath ? basename(prjPath) : source.name}…` })
		const project = await loadProject(source, prjPath, parser)
		useAppStore.getState().setCompare(null) // comparing is for GitHub commits
		showProject(source, project)
		if (handle) await addRecent({ name: project.name, prjPath, handle, openedAt: Date.now() }).catch(() => {})
	} catch (e) {
		setScreen({ kind: "start", error: e instanceof Error ? e.message : String(e) })
	}
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Runs a start-page entry point; any failure lands on the start page as an error.
export async function guarded(fn: () => Promise<void>): Promise<void> {
	try {
		await fn()
	} catch (e) {
		useAppStore.getState().setScreen({ kind: "start", error: message(e) })
	}
}

export function openRecent(recent: RecentProject): Promise<void> {
	return guarded(async () => {
		if (!(await ensureReadPermission(recent.handle))) {
			useAppStore.getState().setScreen({ kind: "start", error: `Permission to read "${recent.handle.name}" was not granted` })
			return
		}
		leaveGitHubRoute()
		await openProject(new DirectoryHandleSource(recent.handle), recent.handle, recent.prjPath)
	})
}
