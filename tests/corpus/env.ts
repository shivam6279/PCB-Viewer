import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

export const CORPUS = process.env.ALTIUM_CORPUS ?? "D:/Projects/PCB"
export const hasCorpus = existsSync(CORPUS)

const SKIP_EXACT = new Set(["history", "__previews", "node_modules"])
const SKIP_PREFIX = ["project logs for ", "project outputs for "]

function skipDir(name: string): boolean {
	const n = name.toLowerCase()
	return n.startsWith(".") || SKIP_EXACT.has(n) || SKIP_PREFIX.some(p => n.startsWith(p))
}

export function listCorpusDocs(dir = CORPUS, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) {
			if (!skipDir(name)) listCorpusDocs(p, out)
		} else if (/\.(schdoc|pcbdoc)$/i.test(name)) out.push(p)
	}
	return out
}
