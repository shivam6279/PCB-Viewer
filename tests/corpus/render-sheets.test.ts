import { describe, expect, test } from "vitest"
import { CORPUS, hasCorpus } from "./env"
import { NodeDirSource } from "../node-dir-source"
import { findProjects, loadProject } from "../../src/model/load-project"
import { localParser } from "../../src/parse/parser"
import { basename } from "../../src/source/paths"

describe.skipIf(!hasCorpus)("rendering every corpus sheet", () => {
	test("each existing sheet of each project renders to a non-trivial SVG", async () => {
		const src = new NodeDirSource(CORPUS)
		const failures: string[] = []
		let rendered = 0
		for (const prj of await findProjects(src)) {
			const project = await loadProject(src, prj, localParser)
			const projectBytes = await src.read(prj)
			for (const doc of project.documents) {
				if (doc.kind !== "sch" || !doc.exists) continue
				try {
					const svg = await localParser.renderSheetSvg(await src.read(doc.path), {
						documentName: doc.name,
						projectBytes,
						projectName: basename(prj),
					})
					if (!svg.startsWith("<svg") || (svg.match(/data-record=/g) ?? []).length < 5)
						failures.push(`${doc.path}: suspiciously empty SVG (${svg.length} chars)`)
					rendered++
				} catch (e) {
					failures.push(`${doc.path}: ${(e as Error).message}`)
				}
			}
		}
		expect(rendered).toBeGreaterThan(100)
		expect(failures).toEqual([])
	})
})
