import { beforeEach, expect, test } from "vitest"
import { openSource } from "./open"
import { useAppStore } from "./store"
import { MemorySource } from "../source/memory-source"
import type { Parser } from "../parse/parser"

const enc = (s: string) => new TextEncoder().encode(s)
const parser: Parser = {
	parseProjectFile: async () => ({ documentPaths: ["Top.SchDoc"], parameters: {}, channelDesignatorFormat: "" }),
	parseSheetLinks: async () => [],
	renderSheetSvg: async () => "",
	buildProjectData: async () => { throw new Error("not used") },
	renderFootprintSvg: async () => null,
	getPcbScene: async () => null,
}

beforeEach(() => useAppStore.setState({ screen: { kind: "start", error: null } }))

test("one project opens straight into the viewer", async () => {
	await openSource(new MemorySource("x", [["A/A.PrjPcb", enc("")], ["A/Top.SchDoc", enc("")]]), null, parser)
	expect(useAppStore.getState().screen).toMatchObject({ kind: "viewer", activeSheetId: "Top.SchDoc" })
})

test("several projects show the picker", async () => {
	await openSource(new MemorySource("x", [["A/A.PrjPcb", enc("")], ["B/B.PrjPcb", enc("")]]), null, parser)
	expect(useAppStore.getState().screen).toMatchObject({ kind: "pick", projects: ["A/A.PrjPcb", "B/B.PrjPcb"] })
})

test("loose documents open without a project", async () => {
	await openSource(new MemorySource("loose", [["Top.SchDoc", enc("")]]), null, parser)
	expect(useAppStore.getState().screen).toMatchObject({ kind: "viewer", project: { prjPath: null, name: "loose" } })
})

test("nothing usable returns to start with an error", async () => {
	await openSource(new MemorySource("empty", [["notes.txt", enc("")]]), null, parser)
	expect(useAppStore.getState().screen).toEqual({ kind: "start", error: 'No Altium project or documents found in "empty"' })
})

test("parser failures surface on the start page", async () => {
	const broken: Parser = { ...parser, parseProjectFile: async () => { throw new Error("bad project file") } }
	await openSource(new MemorySource("x", [["A.PrjPcb", enc("")]]), null, broken)
	expect(useAppStore.getState().screen).toEqual({ kind: "start", error: "bad project file" })
})

test("a recent whose permission is denied reports it on the start page", async () => {
	const { openRecent } = await import("./open")
	const handle = { name: "Moved", kind: "directory", queryPermission: async () => "denied", requestPermission: async () => "denied" } as unknown as FileSystemDirectoryHandle
	await openRecent({ name: "P", prjPath: null, handle, openedAt: 1 })
	expect(useAppStore.getState().screen).toEqual({ kind: "start", error: 'Permission to read "Moved" was not granted' })
})
