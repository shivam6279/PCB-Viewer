#!/usr/bin/env node
// Builds the static GitHub index the site reads instead of calling GitHub's API from the browser
// (which allows a visitor 60 requests an hour). Uses plain git on a clone — no API at all:
//   node tools/build-index.mjs <out-dir> <owner/repo>=<clone url or local path> [...]
// Writes, per repo, under <out-dir>/<owner>/<repo>/:
//   meta.json          { owner, repo, defaultBranch, branches: { name: headSha }, generatedAt }
//   commits.json       [{ sha, parents, author, date, message, paths }]  every commit on any branch
//   trees/<sha>.json   [[path, blobSha], ...]                            the files at each commit
// and <out-dir>/repos.json listing the repos. File contents are not included: the site downloads them
// from GitHub's raw-file CDN.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Folders that never hold source documents but can be large; same rule as src/source/skip.ts.
const SKIP_EXACT = new Set(["history", "__previews", "node_modules", "project outputs", "project logs"])
const SKIP_PREFIX = ["project logs for ", "project outputs for "]
const skipDir = name => {
	const n = name.toLowerCase()
	return n.startsWith(".") || SKIP_EXACT.has(n) || SKIP_PREFIX.some(p => n.startsWith(p))
}
const inSkippedDir = path => path.split("/").slice(0, -1).some(skipDir)

const [outDir, ...specs] = process.argv.slice(2)
if (!outDir || specs.length === 0) {
	console.error("usage: build-index.mjs <out-dir> <owner/repo>=<url-or-path> [...]")
	process.exit(2)
}

const repos = []
for (const spec of specs) {
	const [name, from] = spec.split("=")
	const [owner, repo] = name.split("/")
	const gitDir = prepare(from)
	const git = (...args) => execFileSync("git", ["--git-dir", gitDir, ...args], { maxBuffer: 1 << 30 }).toString("utf8")

	const defaultBranch = git("symbolic-ref", "--short", "HEAD").trim()
	const branches = Object.fromEntries(
		git("for-each-ref", "refs/heads", "--format=%(refname:short) %(objectname)")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(l => l.split(" ")),
	)

	// Every commit with the paths it changed (against its first parent), newest first.
	const SEP = "\x1f", REC = "\x1e"
	const log = git("log", "--branches", "--date-order", `--format=${REC}%H${SEP}%P${SEP}%an${SEP}%aI${SEP}%s`, "--name-only", "--no-renames", "-m", "--first-parent")
	const commits = []
	for (const rec of log.split(REC).slice(1)) {
		const [head, ...rest] = rec.split("\n")
		const [sha, parents, author, date, message] = head.split(SEP)
		commits.push({ sha, parents: parents ? parents.split(" ") : [], author, date, message, paths: rest.map(s => s.trim()).filter(Boolean) })
	}
	// --first-parent leaves out commits only on merged side branches; list those too (paths from git show).
	const listed = new Set(commits.map(c => c.sha))
	for (const sha of git("rev-list", "--branches").trim().split("\n").filter(Boolean)) {
		if (listed.has(sha)) continue
		const [head, ...rest] = git("show", "--no-renames", "--name-only", `--format=%H${SEP}%P${SEP}%an${SEP}%aI${SEP}%s`, sha).split("\n")
		const [s, parents, author, date, message] = head.split(SEP)
		commits.push({ sha: s, parents: parents ? parents.split(" ") : [], author, date, message, paths: rest.map(x => x.trim()).filter(Boolean) })
	}
	commits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

	const dir = join(outDir, owner, repo)
	mkdirSync(join(dir, "trees"), { recursive: true })
	for (const c of commits) {
		const files = git("ls-tree", "-r", "-z", c.sha)
			.split("\0")
			.filter(Boolean)
			.map(line => {
				const [meta, path] = line.split("\t")
				const [, type, blob] = meta.split(" ")
				return type === "blob" && !inSkippedDir(path) ? [path, blob] : null
			})
			.filter(Boolean)
		writeFileSync(join(dir, "trees", `${c.sha}.json`), JSON.stringify(files))
	}
	const generatedAt = new Date().toISOString()
	writeFileSync(join(dir, "commits.json"), JSON.stringify(commits))
	writeFileSync(join(dir, "meta.json"), JSON.stringify({ owner, repo, defaultBranch, branches, generatedAt }))
	repos.push({ owner, repo, defaultBranch, head: branches[defaultBranch], generatedAt })
	console.log(`${owner}/${repo}: ${commits.length} commits, ${Object.keys(branches).length} branches, default ${defaultBranch}`)
}
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, "repos.json"), JSON.stringify(repos))

// A local repo is read in place; a URL is cloned without file contents (commits and trees only).
function prepare(from) {
	if (existsSync(from)) return execFileSync("git", ["-C", from, "rev-parse", "--absolute-git-dir"]).toString().trim()
	const dir = mkdtempSync(join(tmpdir(), "index-"))
	process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
	execFileSync("git", ["clone", "--bare", "--filter=blob:none", "--quiet", from, join(dir, "repo.git")], { stdio: "inherit" })
	return join(dir, "repo.git")
}
