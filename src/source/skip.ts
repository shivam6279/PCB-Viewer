// Folders that never hold source projects but can be huge (Altium history, previews, outputs, VCS).
const SKIP_EXACT = new Set(["history", "__previews", "node_modules", "project outputs", "project logs"])
const SKIP_PREFIX = ["project logs for ", "project outputs for "]

export function shouldSkipDir(name: string): boolean {
	const n = name.toLowerCase()
	return n.startsWith(".") || SKIP_EXACT.has(n) || SKIP_PREFIX.some(p => n.startsWith(p))
}

export function isInSkippedDir(path: string): boolean {
	return path.split("/").slice(0, -1).some(shouldSkipDir)
}
