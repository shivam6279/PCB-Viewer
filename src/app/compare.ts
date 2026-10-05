import { fileChanges } from "../diff/diff"
import { GitCommitSource } from "../github/commit-source"
import { handleAuthError } from "../github/session"
import { loadProject, type ProjectSummary } from "../model/load-project"
import { separateWorkerParser } from "../parse/worker-parser"
import { dirname, extname, PathIndex } from "../source/paths"
import { buildData } from "./load-project-data"
import { useAppStore, type Compare } from "./store"

// Brings the comparison in line with the URL's `vs` for the primary commit just opened: none -> no
// comparison; the same commit as now -> only the file list is redone (the primary may have changed);
// another commit -> it is loaded afresh, on a parse worker of its own.
export async function syncCompare(primary: GitCommitSource, project: ProjectSummary, vs: string | null | undefined): Promise<void> {
	const store = useAppStore.getState()
	if (!vs) return store.setCompare(null)
	const current = store.compare
	if (current && current.sha === vs && current.source && current.project?.prjPath && current.error === null) {
		store.updateCompare({ files: await changesBetween(primary, project, current.source as GitCommitSource, current.project) })
		return
	}

	const parser = separateWorkerParser()
	const compare: Compare = { sha: vs, parser, source: null, project: null, data: { status: "loading" }, files: null, mode: current?.mode ?? "diff", error: null }
	store.setCompare(compare)
	const live = () => useAppStore.getState().compare?.parser === parser
	try {
		const source = new GitCommitSource(primary.gh, primary.ref, vs, primary.scope)
		const files = await source.list()
		const prjPath = project.prjPath ?? ""
		const prj =
			new PathIndex(files).get(prjPath) ?? files.find(p => dirname(p).toLowerCase() === dirname(prjPath).toLowerCase() && extname(p) === ".prjpcb")
		if (!prj) throw new Error(`The project isn't in commit ${vs.slice(0, 7)}`)
		const other = await loadProject(source, prj, parser)
		if (!live()) return
		useAppStore.getState().updateCompare({ source, project: other, files: await changesBetween(primary, project, source, other) })
		const data = await buildData(source, other, parser)
		if (live()) useAppStore.getState().updateCompare({ data: { status: "ready", data } })
	} catch (e) {
		if (!live() || handleAuthError(e)) return
		const message = e instanceof Error ? e.message : String(e)
		useAppStore.getState().updateCompare({ error: message, data: { status: "error", message } })
	}
}

// How each document of either project differs between the two commits, from their git blob shas.
async function changesBetween(a: GitCommitSource, pa: ProjectSummary, b: GitCommitSource, pb: ProjectSummary) {
	const [sa, sb] = await Promise.all([a.blobShas(), b.blobShas()])
	const paths = new Set([...pa.documents, ...pb.documents].filter(d => d.kind !== "other").map(d => d.path))
	return fileChanges(sa, sb, paths)
}
