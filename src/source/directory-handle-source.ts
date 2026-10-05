import { shouldSkipDir } from "./skip"
import { SourceFileNotFound, type ProjectSource } from "./types"

export class DirectoryHandleSource implements ProjectSource {
	readonly name: string

	constructor(readonly handle: FileSystemDirectoryHandle) {
		this.name = handle.name
	}

	async list(): Promise<string[]> {
		const out: string[] = []
		await walk(this.handle, "", out)
		return out
	}

	async read(path: string): Promise<Uint8Array> {
		const parts = path.split("/")
		try {
			let dir = this.handle
			for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part)
			const file = await (await dir.getFileHandle(parts[parts.length - 1]!)).getFile()
			return new Uint8Array(await file.arrayBuffer())
		} catch (e) {
			if (e instanceof DOMException && (e.name === "NotFoundError" || e.name === "TypeMismatchError"))
				throw new SourceFileNotFound(path)
			throw e
		}
	}
}

async function walk(dir: FileSystemDirectoryHandle, prefix: string, out: string[]): Promise<void> {
	for await (const [name, handle] of dir.entries()) {
		const path = prefix ? `${prefix}/${name}` : name
		if (handle.kind === "directory") {
			if (!shouldSkipDir(name)) await walk(handle as FileSystemDirectoryHandle, path, out)
		} else out.push(path)
	}
}
