// A place project files come from: a folder, a zip, dropped files, later a git commit.
// Paths are '/'-separated, relative to the source root, with no leading '/'.
export interface ProjectSource {
	readonly name: string
	list(): Promise<string[]>
	read(path: string): Promise<Uint8Array>
}

export class SourceFileNotFound extends Error {
	constructor(readonly path: string) {
		super(`File not found: ${path}`)
		this.name = "SourceFileNotFound"
	}
}
