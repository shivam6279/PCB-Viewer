import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { zipSync } from "fflate"
import { CORPUS } from "../tests/corpus/env"

export const CUBLI_DIR = join(CORPUS, "Cubli/Main Board/STM32")

// Zips a project folder's own design files under a wrapper folder, the way a user would share it.
export function zipTopLevel(dir: string, wrapper = "STM32"): Buffer {
	const files: Record<string, Uint8Array> = {}
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isFile() && /\.(prjpcb|schdoc|pcbdoc)$/i.test(name)) files[`${wrapper}/${name}`] = new Uint8Array(readFileSync(p))
	}
	return Buffer.from(zipSync(files))
}
