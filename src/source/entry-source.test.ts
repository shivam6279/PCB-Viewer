import { expect, test } from "vitest"
import { entrySource } from "./entry-source"

function fileEntry(name: string, fullPath: string, bytes: Uint8Array): any {
	return { isFile: true, isDirectory: false, name, fullPath, file: (ok: (f: File) => void) => ok(new File([bytes as BlobPart], name)) }
}

function dirEntry(name: string, fullPath: string, children: any[]): any {
	return {
		isFile: false,
		isDirectory: true,
		name,
		fullPath,
		createReader() {
			// Real readers return entries in batches and then an empty batch; emulate two batches.
			const batches = [children.slice(0, 1), children.slice(1), []]
			return { readEntries: (ok: (e: any[]) => void) => ok(batches.shift() ?? []) }
		},
	}
}

test("walks dropped directory entries in batches and skips housekeeping dirs", async () => {
	const b = new Uint8Array([7])
	const root = dirEntry("Cubli", "/Cubli", [
		fileEntry("Cubli.PrjPcb", "/Cubli/Cubli.PrjPcb", b),
		dirEntry("Sheets", "/Cubli/Sheets", [fileEntry("Top.SchDoc", "/Cubli/Sheets/Top.SchDoc", b)]),
		dirEntry("History", "/Cubli/History", [fileEntry("x.PrjPcb", "/Cubli/History/x.PrjPcb", b)]),
	])
	const src = await entrySource("Cubli", [root])
	expect((await src.list()).sort()).toEqual(["Cubli/Cubli.PrjPcb", "Cubli/Sheets/Top.SchDoc"])
	expect(await src.read("Cubli/Sheets/Top.SchDoc")).toEqual(b)
})
