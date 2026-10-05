import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { shouldSkipDir } from "../src/source/skip"
import { SourceFileNotFound, type ProjectSource } from "../src/source/types"

export class NodeDirSource implements ProjectSource {
	readonly name: string

	constructor(private readonly root: string) {
		this.name = basename(root)
	}

	async list(): Promise<string[]> {
		const out: string[] = []
		const walk = (dir: string, prefix: string) => {
			for (const name of readdirSync(dir)) {
				const path = prefix ? `${prefix}/${name}` : name
				if (statSync(join(dir, name)).isDirectory()) {
					if (!shouldSkipDir(name)) walk(join(dir, name), path)
				} else out.push(path)
			}
		}
		walk(this.root, "")
		return out
	}

	async read(path: string): Promise<Uint8Array> {
		try {
			return new Uint8Array(readFileSync(join(this.root, path)))
		} catch {
			throw new SourceFileNotFound(path)
		}
	}
}
