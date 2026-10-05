import { unzipSync } from "fflate"
import { MemorySource } from "./memory-source"
import { normalizePath } from "./paths"
import { isInSkippedDir } from "./skip"

export function zipSource(name: string, bytes: Uint8Array): MemorySource {
	const entries = unzipSync(bytes, {
		filter: f => !f.name.endsWith("/") && !f.name.startsWith("__MACOSX/") && !isInSkippedDir(normalizePath(f.name) ?? ""),
	})
	return new MemorySource(name, Object.entries(entries))
}
