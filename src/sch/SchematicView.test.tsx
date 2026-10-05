// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest"
import { cleanup, render, render as rtl, screen, waitFor } from "@testing-library/react"
import { SchematicView } from "./SchematicView"
import { MemorySource } from "../source/memory-source"
import type { Parser } from "../parse/parser"
import type { ProjectSummary } from "../model/load-project"
import type { HierarchyNode } from "../model/hierarchy"

afterEach(cleanup)

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><g data-record="Wire"><line x1="0" y1="0" x2="10" y2="10"/></g></svg>`

const project: ProjectSummary = {
	name: "Board",
	prjPath: "Board.PrjPcb",
	parameters: {},
	channelDesignatorFormat: "",
	documents: [{ path: "Top.SchDoc", name: "Top.SchDoc", kind: "sch", exists: true, error: null }],
	hierarchy: [],
}
const node: HierarchyNode = { id: "Top.SchDoc", label: "Top.SchDoc", docPath: "Top.SchDoc", fileName: "Top.SchDoc", designator: null, displayDesignator: "Top", channel: null, cyclic: false, children: [] }

function parser(render: Parser["renderSheetSvg"]): Parser {
	return { parseProjectFile: vi.fn(), parseSheetLinks: vi.fn(), renderSheetSvg: render, buildProjectData: vi.fn(), renderFootprintSvg: vi.fn(), getPcbScene: vi.fn() }
}

function source() {
	return new MemorySource("x", [
		["Top.SchDoc", new Uint8Array([1])],
		["Board.PrjPcb", new Uint8Array([2])],
	])
}

test("renders the sheet SVG with the project file and document name", async () => {
	const render = vi.fn(async () => SVG)
	const { container } = render_(render)
	await waitFor(() => expect(container.querySelector('svg [data-record="Wire"]')).toBeTruthy())
	expect(render).toHaveBeenCalledWith(new Uint8Array([1]), { documentName: "Top.SchDoc", projectBytes: new Uint8Array([2]), projectName: "Board.PrjPcb", channel: null })
	expect(container.querySelector("svg")!.getAttribute("viewBox")).toBeTruthy()
})

test("shows the renderer's error instead of a blank canvas", async () => {
	render_(async () => {
		throw new Error("Not a schematic document")
	})
	expect(await screen.findByText(/Not a schematic document/)).toBeTruthy()
})

test("a sheet whose file is missing says so", async () => {
	render(<SchematicView source={source()} project={project} node={{ ...node, docPath: null }} parser={parser(vi.fn())} />)
	expect(await screen.findByText(/not found/i)).toBeTruthy()
})

function render_(fn: Parser["renderSheetSvg"]) {
	return render(<SchematicView source={source()} project={project} node={node} parser={parser(fn)} />)
}

test("a sheet inside a REPEAT channel is rendered for that channel", async () => {
	const esc: HierarchyNode = { ...node, id: "Top.SchDoc/U_ESC2", label: "Top.SchDoc (U_ESC2)", designator: "U_ESC2", channel: 2 }
	const withChannel: ProjectSummary = { ...project, hierarchy: [{ ...node, children: [esc] }] }
	const render = vi.fn(async () => SVG)
	const { container } = rtl(<SchematicView source={source()} project={withChannel} node={esc} parser={parser(render)} />)
	await waitFor(() => expect(container.querySelector("svg")).toBeTruthy())
	expect(render).toHaveBeenCalledWith(new Uint8Array([1]), expect.objectContaining({ channel: { index: 2, name: "U_ESC2" } }))
})
