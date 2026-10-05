// Returns null when the path climbs above the source root.
export function normalizePath(p: string): string | null {
	const out: string[] = []
	for (const part of p.replaceAll("\\", "/").split("/")) {
		if (part === "" || part === ".") continue
		if (part === "..") {
			if (out.length === 0) return null
			out.pop()
		} else out.push(part)
	}
	return out.join("/")
}

export function joinPath(dir: string, rel: string): string | null {
	return normalizePath(dir ? `${dir}/${rel}` : rel)
}

export function dirname(p: string): string {
	const i = p.lastIndexOf("/")
	return i < 0 ? "" : p.slice(0, i)
}

export function basename(p: string): string {
	return p.slice(p.lastIndexOf("/") + 1)
}

export function extname(p: string): string {
	const b = basename(p)
	const i = b.lastIndexOf(".")
	return i <= 0 ? "" : b.slice(i).toLowerCase()
}

export function stripExt(p: string): string {
	const b = basename(p)
	const i = b.lastIndexOf(".")
	return i <= 0 ? b : b.slice(0, i)
}

// Altium paths are Windows paths, so lookups are case-insensitive.
export class PathIndex {
	private readonly byLower = new Map<string, string>()

	constructor(paths: Iterable<string>) {
		for (const p of paths) this.byLower.set(p.toLowerCase(), p)
	}

	get(p: string): string | undefined {
		return this.byLower.get(p.toLowerCase())
	}
}
