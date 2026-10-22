// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ChannelTabs } from "./ChannelTabs"
import type { HierarchyNode } from "../model/hierarchy"

afterEach(cleanup)

const node = (id: string, docPath: string, designator: string | null, channel: number | null, children: HierarchyNode[] = []): HierarchyNode => ({
	id, label: id, docPath, fileName: docPath, designator, displayDesignator: designator ?? docPath, channel, cyclic: false, children,
})
const mcu = (n: number) => node(`Top/U_ESC${n}/U_MCU`, "MCU.SchDoc", "U_MCU", null)
const hierarchy = [node("Top", "Top.SchDoc", null, null, [1, 2].map(n => node(`Top/U_ESC${n}`, "ESC.SchDoc", `U_ESC${n}`, n, [{ ...mcu(n), displayDesignator: `U_MCU${n}` }])))]

test("one tab per channel of the shown sheet's file, the shown one selected", () => {
	const onPick = vi.fn()
	render(<ChannelTabs hierarchy={hierarchy} sheet={hierarchy[0]!.children[1]!.children[0]!} onPick={onPick} />)
	const tabs = screen.getAllByRole("tab")
	expect(tabs.map(t => t.textContent)).toEqual(["CH 1U_MCU1", "CH 2U_MCU2"])
	expect(tabs[1]!.getAttribute("aria-selected")).toBe("true")
	fireEvent.click(tabs[0]!)
	expect(onPick).toHaveBeenCalledWith("Top/U_ESC1/U_MCU")
})

test("nothing for a sheet used once", () => {
	render(<ChannelTabs hierarchy={hierarchy} sheet={hierarchy[0]!} onPick={vi.fn()} />)
	expect(screen.queryByRole("tablist")).toBeNull()
})
