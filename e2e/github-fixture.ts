import { execFileSync } from "node:child_process"
import type { Page, Route } from "@playwright/test"
import { CORPUS } from "../tests/corpus/env"

// A stand-in for api.github.com, answered from the local corpus repo with the git CLI, so the GitHub
// flow runs offline, without a token, against real history.
export const OWNER = "shivam6279"
export const REPO = "PCB"

const git = (args: string[]) => execFileSync("git", args, { cwd: CORPUS, maxBuffer: 1 << 30 })
const gitText = (args: string[]) => git(args).toString("utf8")
const branch = () => gitText(["rev-parse", "--abbrev-ref", "HEAD"]).trim()

const SEP = "\x1f"
const FORMAT = ["%H", "%an", "%aI", "%B"].join(SEP) + "\x1e"

function commits(args: string[]) {
	return gitText(["log", `--format=${FORMAT}`, ...args])
		.split("\x1e")
		.map(s => s.trim())
		.filter(Boolean)
		.map(rec => {
			const [sha, name, date, message] = rec.split(SEP) as [string, string, string, string]
			return { sha, commit: { message, author: { name, date } }, author: { login: OWNER } }
		})
}

const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "Link, ETag, X-RateLimit-Remaining, X-RateLimit-Reset" }

export interface FakeGitHub {
	requests: string[]
	token: string
	blobDelayMs: number // slows file downloads, to see progress on screen
}

export async function fakeGitHub(page: Page, token = "github_pat_fixture"): Promise<FakeGitHub> {
	const state: FakeGitHub = { requests: [], token, blobDelayMs: 0 }
	await page.route("https://api.github.com/**", route => handle(route, state))
	// The raw-file CDN anonymous visitors download files from: /<owner>/<repo>/<sha>/<path>.
	await page.route("https://raw.githubusercontent.com/**", route => {
		const parts = new URL(route.request().url()).pathname.split("/").slice(1).map(decodeURIComponent)
		const [, , sha, ...path] = parts
		state.requests.push(`raw:${path.join("/")}`)
		try {
			return route.fulfill({ status: 200, headers: CORS, body: git(["show", `${sha}:${path.join("/")}`]) })
		} catch {
			return route.fulfill({ status: 404, headers: CORS, body: "404: Not Found" })
		}
	})
	return state
}

async function handle(route: Route, state: FakeGitHub) {
	const req = route.request()
	if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*" } })
	const url = new URL(req.url())
	state.requests.push(url.pathname + url.search)
	const json = (body: unknown, headers: Record<string, string> = {}) =>
		route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
	// Like GitHub: a wrong token is refused; no token reads public data (and /user needs one).
	const auth = req.headers()["authorization"]
	if ((auth !== undefined && auth !== `Bearer ${state.token}`) || (auth === undefined && url.pathname === "/user"))
		return route.fulfill({ status: 401, headers: CORS, body: '{"message":"Bad credentials"}' })

	const p = url.pathname
	const q = url.searchParams
	const repoBase = `/repos/${OWNER}/${REPO}`
	const repo = { name: REPO, owner: { login: OWNER }, default_branch: branch(), private: true, pushed_at: "2026-03-22T00:00:00Z", archived: false }

	if (p === "/user") return json({ login: OWNER })
	if (p === "/user/repos" || p === `/users/${OWNER}/repos`) return json([repo])
	if (p === repoBase) return json(repo)
	if (p === `${repoBase}/branches`) return json([{ name: branch() }])
	if (p.startsWith(`${repoBase}/commits/`)) return json(commits(["-1", decodeURIComponent(p.slice(`${repoBase}/commits/`.length))])[0])
	if (p === `${repoBase}/commits`) {
		const per = Number(q.get("per_page") ?? 30)
		const pg = Number(q.get("page") ?? 1)
		const path = q.get("path") ?? ""
		const all = commits([`--skip=${(pg - 1) * per}`, `-n${per + 1}`, q.get("sha") ?? "HEAD", "--", path || "."])
		const headers: Record<string, string> = {}
		if (all.length > per) {
			const next = new URL(url)
			next.searchParams.set("page", String(pg + 1))
			headers.link = `<${next}>; rel="next"`
		}
		return json(all.slice(0, per), headers)
	}
	const tree = /^\/repos\/[^/]+\/[^/]+\/git\/trees\/([^/]+)$/.exec(p)
	if (tree) {
		const recursive = q.get("recursive") === "1"
		const out = gitText(["ls-tree", "-z", ...(recursive ? ["-r", "-t"] : []), tree[1]!])
		const entries = out
			.split("\0")
			.filter(Boolean)
			.map(line => {
				const [meta, path] = line.split("\t") as [string, string]
				const [, type, sha] = meta.split(" ") as [string, string, string]
				return { path, type, sha, mode: "100644" }
			})
		return json({ sha: tree[1], truncated: false, tree: entries })
	}
	const blob = /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/([0-9a-f]+)$/.exec(p)
	if (blob && state.blobDelayMs) await new Promise(r => setTimeout(r, state.blobDelayMs))
	if (blob) return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/octet-stream" }, body: git(["cat-file", "blob", blob[1]!]) })
	return route.fulfill({ status: 404, headers: CORS, body: '{"message":"Not Found"}' })
}

export function cubliCommits(): string[] {
	return commits(["--", "Cubli/Main Board/STM32"]).map(c => c.sha)
}

export function headSha(): string {
	return gitText(["rev-parse", "HEAD"]).trim()
}

// The static index the deploy publishes beside the page, built from the corpus repo with the same
// script, served for /index/** — the path where the site looks for it.
export async function serveIndex(page: Page): Promise<string[]> {
	const { mkdtempSync, readFileSync } = await import("node:fs")
	const { tmpdir } = await import("node:os")
	const { join } = await import("node:path")
	const out = mkdtempSync(join(tmpdir(), "viewer-index-"))
	execFileSync(process.execPath, ["tools/build-index.mjs", out, `${OWNER}/${REPO}=${CORPUS}`], { stdio: "ignore" })
	const served: string[] = []
	await page.route(/\/index\/(.+\.json)$/, route => {
		const rel = /\/index\/(.+\.json)$/.exec(new URL(route.request().url()).pathname)![1]!
		served.push(rel)
		try {
			return route.fulfill({ status: 200, contentType: "application/json", body: readFileSync(join(out, ...rel.split("/").map(decodeURIComponent))) })
		} catch {
			return route.fulfill({ status: 404, body: "" })
		}
	})
	return served
}
