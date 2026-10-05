import { DirectoryHandleSource } from "./directory-handle-source"
import { entrySource } from "./entry-source"
import type { ProjectSource } from "./types"
import { zipSource } from "./zip-source"

export interface DroppedSource {
	source: ProjectSource
	handle: FileSystemDirectoryHandle | null
}

// DataTransfer items are only valid synchronously inside the drop handler, so everything is
// captured before the first await.
export async function sourceFromDrop(dt: DataTransfer): Promise<DroppedSource | null> {
	const items = [...dt.items].filter(i => i.kind === "file")
	const entries = items.map(i => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => e !== null)
	const handlePromise = items.length === 1 ? items[0]!.getAsFileSystemHandle?.() : undefined
	const lone = items.length === 1 ? items[0]!.getAsFile() : null
	if (entries.length === 0) return null

	const handle = await handlePromise?.catch(() => null)
	if (handle && handle.kind === "directory") {
		const dir = handle as FileSystemDirectoryHandle
		return { source: new DirectoryHandleSource(dir), handle: dir }
	}

	if (lone && lone.name.toLowerCase().endsWith(".zip"))
		return { source: zipSource(lone.name, new Uint8Array(await lone.arrayBuffer())), handle: null }

	const name = entries.length === 1 ? entries[0]!.name : "Dropped files"
	return { source: await entrySource(name, entries), handle: null }
}
