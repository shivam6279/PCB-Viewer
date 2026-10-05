import { isInSkippedDir } from "../source/skip"
import { SourceFileNotFound, type ProjectSource } from "../source/types"
import type { GitHub, RepoRef } from "./github"

const LFS_MAGIC = "version https://git-lfs"

// One repo at one commit, rooted at the repo root so a project's "..\Shared\X.SchDoc" resolves.
export class GitCommitSource implements ProjectSource {
	readonly name: string
	private files: Promise<Map<string, string>> | null = null
	private requested = new Set<string>()
	private finished = new Set<string>()
	// Called as files are requested and arrive (distinct paths), for a progress readout.
	onProgress: ((done: number, total: number) => void) | null = null

	constructor(
		readonly gh: GitHub,
		readonly ref: RepoRef,
		readonly sha: string,
		readonly scope = "", // the project folder: all that gets listed if GitHub truncates the tree
	) {
		this.name = `${ref.repo} @ ${sha.slice(0, 7)}`
	}

	private tree(): Promise<Map<string, string>> {
		this.files ??= this.gh.tree(this.ref, this.sha, this.scope).then(t => t.files)
		this.files.catch(() => (this.files = null)) // let a failed listing be retried
		return this.files
	}

	// Path -> git blob sha at this commit (two commits' files differ exactly when their shas do).
	blobShas(): Promise<Map<string, string>> {
		return this.tree()
	}

	async list(): Promise<string[]> {
		return [...(await this.tree()).keys()].filter(p => !isInSkippedDir(p))
	}

	async read(path: string): Promise<Uint8Array> {
		const sha = (await this.tree()).get(path)
		if (!sha) throw new SourceFileNotFound(path)
		this.requested.add(path)
		this.report()
		const bytes = await this.gh.file(this.ref, this.sha, path, sha).finally(() => {
			this.finished.add(path)
			this.report()
		})
		if (bytes.byteLength < 512 && new TextDecoder().decode(bytes.subarray(0, LFS_MAGIC.length)) === LFS_MAGIC)
			throw new Error(`${path} is stored in Git LFS, which isn't supported yet`)
		return bytes
	}

	private report(): void {
		this.onProgress?.(this.finished.size, this.requested.size)
	}
}
