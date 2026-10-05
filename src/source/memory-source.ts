import { normalizePath } from "./paths"
import { SourceFileNotFound, type ProjectSource } from "./types"

export class MemorySource implements ProjectSource {
	private readonly files = new Map<string, Uint8Array>()

	constructor(
		readonly name: string,
		files: Iterable<[string, Uint8Array]>,
	) {
		for (const [path, bytes] of files) {
			const n = normalizePath(path)
			if (n) this.files.set(n, bytes)
		}
	}

	async list(): Promise<string[]> {
		return [...this.files.keys()]
	}

	async read(path: string): Promise<Uint8Array> {
		const bytes = this.files.get(path)
		if (!bytes) throw new SourceFileNotFound(path)
		return bytes
	}
}
