// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ProjectTree } from "./ProjectTree"
import type { ProjectSummary } from "../model/load-project"

afterEach(cleanup)

const project: ProjectSummary = {
	name: "Board",
	prjPath: "Board.PrjPcb",
	parameters: {},
	channelDesignatorFormat: "",
	documents: [
		{ path: "Top.SchDoc", name: "Top.SchDoc", kind: "sch", exists: true, error: null },
		{ path: "ESC.SchDoc", name: "ESC.SchDoc", kind: "sch", exists: true, error: "corrupt sheet" },
		{ path: "Board.PcbDoc", name: "Board.PcbDoc", kind: "pcb", exists: true, error: null },
		{ path: "Board.PCBDwf", name: "Board.PCBDwf", kind: "other", exists: true, error: null },
		{ path: "Gone.PcbDoc", name: "Gone.PcbDoc", kind: "pcb", exists: false, error: null },
	],
	hierarchy: [
		{
			id: "Top.SchDoc", label: "Top.SchDoc", docPath: "Top.SchDoc", fileName: "Top.SchDoc", designator: null, displayDesignator: "Top", channel: null, cyclic: false,
			children: [{ id: "Top.SchDoc/U_ESC1", label: "ESC.SchDoc (U_ESC1)", docPath: "ESC.SchDoc", fileName: "ESC.SchDoc", designator: "U_ESC1", displayDesignator: "U_ESC1", channel: 1, cyclic: false, children: [] }],
		},
	],
}

function renderTree(onSelectSheet = vi.fn(), onSelectPcb = vi.fn()) {
	render(<ProjectTree project={project} activeSheetId="Top.SchDoc" activePcbPath={null} onSelectSheet={onSelectSheet} onSelectPcb={onSelectPcb} />)
	return { onSelectSheet, onSelectPcb }
}

test("shows the hierarchy, PCB and other docs under Source Documents", () => {
	renderTree()
	for (const t of ["Design", "Source Documents", "Top.SchDoc", "ESC.SchDoc (U_ESC1)", "Board.PcbDoc", "Board.PCBDwf"]) expect(screen.getByText(t)).toBeTruthy()
})

test("clicking nodes selects sheets and boards", () => {
	const { onSelectSheet, onSelectPcb } = renderTree()
	fireEvent.click(screen.getByText("ESC.SchDoc (U_ESC1)"))
	expect(onSelectSheet).toHaveBeenCalledWith("Top.SchDoc/U_ESC1")
	fireEvent.click(screen.getByText("Board.PcbDoc"))
	expect(onSelectPcb).toHaveBeenCalledWith("Board.PcbDoc")
})

test("errors and missing files carry a warning with the reason", () => {
	renderTree()
	expect(screen.getByTitle("corrupt sheet")).toBeTruthy()
	expect(screen.getByTitle("File not found")).toBeTruthy()
})

test("unsupported documents are greyed and not clickable", () => {
	const { onSelectSheet, onSelectPcb } = renderTree()
	const dwf = screen.getByText("Board.PCBDwf")
	expect(dwf.closest("[aria-disabled='true']")).toBeTruthy()
	fireEvent.click(dwf)
	expect(onSelectSheet).not.toHaveBeenCalled()
	expect(onSelectPcb).not.toHaveBeenCalled()
})

test("collapsing a node hides its children", () => {
	renderTree()
	fireEvent.click(screen.getByLabelText("Collapse Top.SchDoc"))
	expect(screen.queryByText("ESC.SchDoc (U_ESC1)")).toBeNull()
})
