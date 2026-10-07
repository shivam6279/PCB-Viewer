import { expect, test } from "vitest"
import { MemorySource } from "../source/memory-source"
import type { Parser } from "../parse/parser"
import type { SheetLink } from "../parse/altium"
import { docKind, findLooseDocuments, findProjects, loadProject } from "./load-project"

const enc = (s: string) => new TextEncoder().encode(s)

// Fake parser: project files are JSON, sheets are JSON link lists, "BAD" throws.
const fakeParser: Parser = {
	async parseProjectFile(bytes) {
		const j = JSON.parse(new TextDecoder().decode(bytes))
		return { documentPaths: j.docs, parameters: j.params ?? {}, channelDesignatorFormat: "$Component_$ChannelIndex" }
	},
	async parseSheetLinks(bytes) {
		const s = new TextDecoder().decode(bytes)
		if (s === "BAD") throw new Error("corrupt sheet")
		return JSON.parse(s) as SheetLink[]
	},
	renderSheetSvg: async () => "",
	buildProjectData: async () => { throw new Error("not used") },
	getPcbScene: async () => null,
}

function source(files: Record<string, string>) {
	return new MemorySource("test", Object.entries(files).map(([p, s]) => [p, enc(s)] as [string, Uint8Array]))
}

test("docKind", () => {
	expect(docKind("a/Top.SCHDOC")).toBe("sch")
	expect(docKind("Board.PcbDoc")).toBe("pcb")
	expect(docKind("Board.PCBDwf")).toBe("other")
})

test("findProjects finds nested projects and ignores housekeeping folders", async () => {
	const src = source({
		"Wrapper/A/A.PrjPcb": "{}",
		"Wrapper/B/Rev2/B.PrjPcb": "{}",
		"Wrapper/A/History/A.PrjPcb": "{}",
		"Wrapper/A/Top.SchDoc": "[]",
	})
	expect(await findProjects(src)).toEqual(["Wrapper/A/A.PrjPcb", "Wrapper/B/Rev2/B.PrjPcb"])
	expect(await findLooseDocuments(src)).toEqual(["Wrapper/A/Top.SchDoc"])
})

test("resolves odd document paths, marks missing and corrupt docs, drops outputs", async () => {
	const src = source({
		"proj/rev1/Board.PrjPcb": JSON.stringify({
			docs: ["TOP.schdoc", "..\\shared\\Power.SchDoc", "..\\..\\..\\escape.SchDoc", "Gone.SchDoc", "Bad.SchDoc", "Board.PcbDoc", "Gerbers\\Board.GTL"],
			params: { ProjectTitle: "T" },
		}),
		"proj/rev1/Top.SchDoc": JSON.stringify([{ fileName: "Power.SchDoc", designator: "U_Power" }]),
		"proj/shared/Power.SchDoc": "[]",
		"proj/rev1/Bad.SchDoc": "BAD",
		"proj/rev1/Board.PcbDoc": "pcb",
	})
	const p = await loadProject(src, "proj/rev1/Board.PrjPcb", fakeParser)

	expect(p.name).toBe("Board")
	expect(p.parameters).toEqual({ ProjectTitle: "T" })
	expect(p.documents.map(d => [d.name, d.kind, d.exists, d.error])).toEqual([
		["TOP.schdoc", "sch", true, null],
		["Power.SchDoc", "sch", true, null],
		["escape.SchDoc", "sch", false, null],
		["Gone.SchDoc", "sch", false, null],
		["Bad.SchDoc", "sch", true, "corrupt sheet"],
		["Board.PcbDoc", "pcb", true, null],
	])
	expect(p.documents[0]!.path).toBe("proj/rev1/Top.SchDoc")
	expect(p.hierarchy[0]!.label).toBe("Top.SchDoc (Top)")
	expect(p.hierarchy[0]!.children[0]!.docPath).toBe("proj/shared/Power.SchDoc")
})

test("loose mode builds a summary from bare documents", async () => {
	const src = source({ "Top.SchDoc": "[]", "Board.PcbDoc": "pcb" })
	const p = await loadProject(src, null, fakeParser)
	expect(p.prjPath).toBeNull()
	expect(p.name).toBe("test")
	expect(p.documents.map(d => d.name).sort()).toEqual(["Board.PcbDoc", "Top.SchDoc"])
	expect(p.hierarchy.map(n => n.label)).toEqual(["Top.SchDoc (Top)"])
})
