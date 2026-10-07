// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { DocBar } from "./DocBar"
import type { ProjectSummary } from "../model/load-project"

afterEach(cleanup)

const base: ProjectSummary = {
	name: "Board",
	prjPath: null,
	parameters: {},
	channelDesignatorFormat: "",
	variants: [],
	documents: [{ path: "Top.SchDoc", name: "Top.SchDoc", kind: "sch", exists: true, error: null }],
	hierarchy: [
		{
			id: "Top.SchDoc", label: "Top.SchDoc", docPath: "Top.SchDoc", fileName: "Top.SchDoc", designator: null, displayDesignator: "Top", channel: null, cyclic: false,
			children: [{ id: "Top.SchDoc/U_P", label: "Power.SchDoc (U_P)", docPath: null, fileName: "Power.SchDoc", designator: "U_P", displayDesignator: "U_P", channel: null, cyclic: false, children: [] }],
		},
	],
}

test("tabs switch and PCB/3D are disabled without a board", () => {
	const onTab = vi.fn()
	render(<DocBar project={base} tab="sch" activeSheetId="Top.SchDoc" onTab={onTab} onSelectSheet={vi.fn()} />)
	expect((screen.getByRole("tab", { name: "PCB" }) as HTMLButtonElement).disabled).toBe(true)
	expect((screen.getByRole("tab", { name: "3D" }) as HTMLButtonElement).disabled).toBe(true)
	expect(screen.getByRole("tab", { name: "SCH" }).getAttribute("aria-selected")).toBe("true")
})

test("sheet picker lists every hierarchy node and selects by id", () => {
	const onSelectSheet = vi.fn()
	render(<DocBar project={base} tab="sch" activeSheetId="Top.SchDoc" onTab={vi.fn()} onSelectSheet={onSelectSheet} />)
	const picker = screen.getByLabelText("Sheet") as HTMLSelectElement
	expect([...picker.options].map(o => o.text)).toEqual(["Top (Top)", "Power (U_P)"])
	fireEvent.change(picker, { target: { value: "Top.SchDoc/U_P" } })
	expect(onSelectSheet).toHaveBeenCalledWith("Top.SchDoc/U_P")
})
