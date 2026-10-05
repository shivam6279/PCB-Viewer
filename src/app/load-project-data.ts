import { compileInstances } from "../model/compile"
import type { ProjectSummary } from "../model/load-project"
import type { Parser } from "../parse/parser"
import type { ProjectData } from "../parse/project-data"
import type { ProjectSource } from "../source/types"
import { useAppStore } from "./store"

// Reads every sheet and the first board and compiles the project in the parser's worker.
export async function buildData(source: ProjectSource, project: ProjectSummary, parser: Parser): Promise<ProjectData> {
	const sheetDocs = project.documents.filter(d => d.kind === "sch" && d.exists)
	const pcbDoc = project.documents.find(d => d.kind === "pcb" && d.exists)
	const [sheets, pcb, projectFile] = await Promise.all([
		Promise.all(sheetDocs.map(async d => [d.path, await source.read(d.path)] as [string, Uint8Array])),
		pcbDoc ? source.read(pcbDoc.path) : null,
		project.prjPath ? source.read(project.prjPath) : null,
	])
	return parser.buildProjectData({
		instances: compileInstances(project.hierarchy),
		designatorFormat: project.channelDesignatorFormat,
		sheets,
		pcb,
		project: projectFile,
	})
}

// The open project's data, into the store. The drawings don't wait for it; clicks start working once
// it lands.
export async function loadProjectData(source: ProjectSource, project: ProjectSummary, parser: Parser): Promise<void> {
	const { setProjectData } = useAppStore.getState()
	const stillCurrent = () => {
		const { screen: s, parked } = useAppStore.getState()
		return (s.kind === "viewer" && s.project === project) || parked?.project === project
	}
	try {
		const data = await buildData(source, project, parser)
		if (stillCurrent()) setProjectData({ status: "ready", data })
	} catch (e) {
		if (stillCurrent()) setProjectData({ status: "error", message: e instanceof Error ? e.message : String(e) })
	}
}
