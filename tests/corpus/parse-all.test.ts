import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { parseAltiumFile } from "altiumts"
import { hasCorpus, listCorpusDocs } from "./env"

describe.skipIf(!hasCorpus)("corpus", () => {
	test("every SchDoc and PcbDoc parses", () => {
		const failures: string[] = []
		const docs = listCorpusDocs()
		for (const path of docs) {
			try {
				parseAltiumFile(new Uint8Array(readFileSync(path)))
			} catch (e) {
				failures.push(`${path}: ${(e as Error).message}`)
			}
		}
		expect(docs.length).toBeGreaterThan(0)
		expect(failures).toEqual([])
	})
})
