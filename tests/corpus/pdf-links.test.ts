import { readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { describe, expect, test } from "vitest"
import { CORPUS, hasCorpus } from "./env"
import { projectData } from "./project-data"
import { NodeDirSource } from "../node-dir-source"
import { loadProject } from "../../src/model/load-project"
import { localParser } from "../../src/parse/parser"
import { flattenHierarchy } from "../../src/model/hierarchy"
import { sheetLinks } from "../../src/sch/pdf/links"

function projects(dir = CORPUS, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) {
			if (!/^(\.|history$|__previews$|project (logs|outputs) for )/i.test(name)) projects(p, out)
		} else if (/\.prjpcb$/i.test(name)) out.push(p)
	}
	return out
}

describe.skipIf(!hasCorpus)("PDF links", () => {
	test("Cubli: every sheet entry and every port below the top sheet leads to the other end", async () => {
		const dir = join(CORPUS, "Cubli/Main Board/STM32")
		const project = await loadProject(new NodeDirSource(dir), "Cubli.PrjPcb", localParser)
		const data = await projectData(dir, "Cubli.PrjPcb")
		const links = sheetLinks(project.hierarchy, data.compiled, data.sheets)
		const nodes = flattenHierarchy(project.hierarchy)
		for (const node of nodes) {
			const sheet = data.sheets[node.docPath!]!
			const from = new Set((links.get(node.id) ?? []).flatMap(l => ("i" in l.from ? [l.from.i] : [])))
			const entries = sheet.objects.filter(o => o.kind === "entry")
			expect(entries.filter(e => !from.has(e.i)).map(e => e.name), `${node.label} entries`).toEqual([])
			if (node.children.length === 0 && nodes[0] !== node) {
				const ports = sheet.objects.filter(o => o.kind === "port")
				expect(ports.filter(p => !from.has(p.i)).map(p => p.name), `${node.label} ports`).toEqual([])
			}
			for (const link of links.get(node.id) ?? []) {
				const target = nodes.find(n => n.id === link.to.instanceId)!
				const ids = new Set(data.sheets[target.docPath!]!.objects.map(o => o.i))
				for (const i of link.to.objects) expect(ids.has(i)).toBe(true)
			}
		}
	})

	test("every corpus project: links found, none pointing at its own sheet", async () => {
		const unlinked: string[] = []
		for (const prj of projects()) {
			const dir = dirname(prj)
			const name = relative(dir, prj)
			const project = await loadProject(new NodeDirSource(dir), name, localParser)
			const data = await projectData(dir, name)
			const links = sheetLinks(project.hierarchy, data.compiled, data.sheets)
			for (const node of flattenHierarchy(project.hierarchy)) {
				const sheet = node.docPath ? data.sheets[node.docPath] : undefined
				if (!sheet) continue
				const from = new Set((links.get(node.id) ?? []).flatMap(l => ("i" in l.from ? [l.from.i] : [])))
				for (const l of links.get(node.id) ?? []) expect(l.to.instanceId).not.toBe(node.id)
				const missing = sheet.objects.filter(o => (o.kind === "port" || o.kind === "entry") && !from.has(o.i))
				if (missing.length) unlinked.push(`${relative(CORPUS, prj)} ${node.label}: ${missing.map(o => ("name" in o ? o.name : o.i)).join(", ")}`)
			}
		}
		console.log(`not linked:\n${unlinked.join("\n")}`)
	})
})

describe.skipIf(!hasCorpus)("channel note", () => {
	test("Cubli: one ESC page names R5_ESC_* and VSNS_ESC_*, * being 1, 2, 3", async () => {
		const { channelNote, namesPerInstance, wildcard } = await import("../../src/sch/pdf/channel-note")
		const dir = join(CORPUS, "Cubli/Main Board/STM32")
		const project = await loadProject(new NodeDirSource(dir), "Cubli.PrjPcb", localParser)
		const data = await projectData(dir, "Cubli.PrjPcb")
		const members = flattenHierarchy(project.hierarchy).filter(n => n.fileName === "ESC.SchDoc")
		const names = namesPerInstance(members, data.compiled)
		const designators = [...names.designators.values()].map(wildcard).filter(w => w !== null)
		expect(designators.length).toBeGreaterThan(20)
		for (const w of designators) expect(w!.parts).toEqual(["1", "2", "3"])
		const objects = { designators: [...names.designators.keys()], nets: [...names.nets.keys()].filter(i => wildcard(names.nets.get(i)!)) }
		const note = channelNote("ESC.SchDoc", members, data.compiled, objects)
		expect(note.channels.map(c => [c.name, c.designators, c.nets])).toEqual([
			["U_ESC1", "1", "1"],
			["U_ESC2", "2", "2"],
			["U_ESC3", "3", "3"],
		])
	})
})
