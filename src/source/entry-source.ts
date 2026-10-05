import { shouldSkipDir } from "./skip"
import { SourceFileNotFound, type ProjectSource } from "./types"

// Dropped files/folders exposed through the (webkit) FileSystemEntry API. Files are read lazily.
export class EntrySource implements ProjectSource {
	constructor(
		readonly name: string,
		private readonly files: Map<string, FileSystemFileEntry>,
	) {}

	async list(): Promise<string[]> {
		return [...this.files.keys()]
	}

	async read(path: string): Promise<Uint8Array> {
		const entry = this.files.get(path)
		if (!entry) throw new SourceFileNotFound(path)
		const file = await new Promise<File>((ok, fail) => entry.file(ok, fail))
		return new Uint8Array(await file.arrayBuffer())
	}
}

export async function entrySource(name: string, roots: FileSystemEntry[]): Promise<EntrySource> {
	const files = new Map<string, FileSystemFileEntry>()
	for (const root of roots) await collect(root, files)
	return new EntrySource(name, files)
}

async function collect(entry: FileSystemEntry, files: Map<string, FileSystemFileEntry>): Promise<void> {
	if (entry.isFile) {
		files.set(entry.fullPath.replace(/^\/+/, ""), entry as FileSystemFileEntry)
		return
	}
	if (shouldSkipDir(entry.name)) return
	const reader = (entry as FileSystemDirectoryEntry).createReader()
	for (;;) {
		const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail))
		if (batch.length === 0) break
		for (const child of batch) await collect(child, files)
	}
}
