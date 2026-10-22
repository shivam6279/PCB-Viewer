import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NodeDirSource } from "../node-dir-source"
import { loadProject } from "../../src/model/load-project"
import { compileInstances } from "../../src/model/compile"
import { localParser } from "../../src/parse/parser"
import { buildProjectData } from "../../src/parse/project-data"

// A corpus project's data, built as the parse worker builds it.
export async function projectData(dir: string, prj: string) {
	const project = await loadProject(new NodeDirSource(dir), prj, localParser)
	const read = (path: string) => new Uint8Array(readFileSync(join(dir, path)))
	const pcb = project.documents.find(d => d.kind === "pcb" && d.exists)
	const bomDoc = project.documents.find(d => /\.bomdoc$/i.test(d.path) && d.exists)
	return buildProjectData({
		instances: compileInstances(project.hierarchy),
		designatorFormat: project.channelDesignatorFormat,
		sheets: project.documents.filter(d => d.kind === "sch" && d.exists).map(d => [d.path, read(d.path)]),
		pcb: pcb ? read(pcb.path) : null,
		bomDoc: bomDoc ? { name: bomDoc.path, bytes: read(bomDoc.path) } : null,
	})
}
