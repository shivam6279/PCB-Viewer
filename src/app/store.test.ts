import { beforeEach, expect, test } from "vitest"
import { useAppStore } from "./store"
import { MemorySource } from "../source/memory-source"
import type { ProjectSummary } from "../model/load-project"

const project: ProjectSummary = {
	name: "Board",
	prjPath: "Board.PrjPcb",
	parameters: {},
	channelDesignatorFormat: "$Component_$ChannelIndex",
	documents: [
		{ path: "Top.SchDoc", name: "Top.SchDoc", kind: "sch", exists: true, error: null },
		{ path: "Board.PcbDoc", name: "Board.PcbDoc", kind: "pcb", exists: true, error: null },
	],
	hierarchy: [{ id: "Top.SchDoc", label: "Top.SchDoc", docPath: "Top.SchDoc", fileName: "Top.SchDoc", designator: null, displayDesignator: "Top", channel: null, cyclic: false, children: [] }],
}

beforeEach(() => useAppStore.setState({ screen: { kind: "start", error: null }, parked: null }))

test("showProject opens the SCH tab on the first root sheet", () => {
	useAppStore.getState().showProject(new MemorySource("x", []), project)
	expect(useAppStore.getState().screen).toMatchObject({ kind: "viewer", tab: "sch", activeSheetId: "Top.SchDoc", activePcbPath: "Board.PcbDoc" })
})

test("showProject falls back to PCB when there are no sheets", () => {
	useAppStore.getState().showProject(new MemorySource("x", []), { ...project, hierarchy: [] })
	expect(useAppStore.getState().screen).toMatchObject({ kind: "viewer", tab: "pcb", activeSheetId: null })
})

test("selectSheet switches to SCH; selectPcb switches to PCB", () => {
	const s = useAppStore.getState()
	s.showProject(new MemorySource("x", []), project)
	s.selectPcb("Board.PcbDoc")
	expect(useAppStore.getState().screen).toMatchObject({ tab: "pcb" })
	s.selectSheet("Top.SchDoc")
	expect(useAppStore.getState().screen).toMatchObject({ tab: "sch", activeSheetId: "Top.SchDoc" })
})

test("leaving the viewer parks it as it was; returning restores it; a new project replaces it", () => {
	const s = useAppStore.getState()
	s.showProject(new MemorySource("x", []), project)
	s.setTab("3d")
	s.select({ kind: "component", id: "U1" })
	s.setScreen({ kind: "start", error: null })
	expect(useAppStore.getState().parked).toMatchObject({ kind: "viewer", tab: "3d" })
	// Browsing the home screen keeps it parked.
	s.setScreen({ kind: "ghProject", owner: "o", repo: "r", prjPath: "p", branch: null, error: null })
	expect(useAppStore.getState().parked).not.toBeNull()
	s.returnToViewer()
	expect(useAppStore.getState()).toMatchObject({ screen: { kind: "viewer", tab: "3d" }, parked: null, selection: { kind: "component", id: "U1" } })

	s.setScreen({ kind: "start", error: null })
	s.showProject(new MemorySource("y", []), { ...project, name: "Other" })
	expect(useAppStore.getState()).toMatchObject({ screen: { kind: "viewer", tab: "sch" }, parked: null, selection: null })
})
