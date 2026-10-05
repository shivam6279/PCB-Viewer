import { expect, test } from "vitest"
import { DirectoryHandleSource } from "./directory-handle-source"
import { SourceFileNotFound } from "./types"

type Tree = { [name: string]: Uint8Array | Tree }

function fakeFile(name: string, bytes: Uint8Array) {
	return { kind: "file", name, getFile: async () => new Blob([bytes as BlobPart]) }
}

function fakeDir(name: string, tree: Tree): any {
	return {
		kind: "directory",
		name,
		async *entries() {
			for (const [k, v] of Object.entries(tree)) yield [k, v instanceof Uint8Array ? fakeFile(k, v) : fakeDir(k, v)]
		},
		async getDirectoryHandle(n: string) {
			const v = tree[n]
			if (!v || v instanceof Uint8Array) throw new DOMException("missing", "NotFoundError")
			return fakeDir(n, v)
		},
		async getFileHandle(n: string) {
			const v = tree[n]
			if (!(v instanceof Uint8Array)) throw new DOMException("missing", "NotFoundError")
			return fakeFile(n, v)
		},
	}
}

test("lists recursively, skipping housekeeping dirs, and reads files", async () => {
	const b = new Uint8Array([1, 2, 3])
	const src = new DirectoryHandleSource(
		fakeDir("PCB", {
			"Board.PrjPcb": b,
			Rev1: { "Top.SchDoc": b },
			History: { "Board.PrjPcb": b },
			".git": { config: b },
		}),
	)
	expect(src.name).toBe("PCB")
	expect((await src.list()).sort()).toEqual(["Board.PrjPcb", "Rev1/Top.SchDoc"])
	expect(await src.read("Rev1/Top.SchDoc")).toEqual(b)
	await expect(src.read("Rev1/Nope.SchDoc")).rejects.toBeInstanceOf(SourceFileNotFound)
})
