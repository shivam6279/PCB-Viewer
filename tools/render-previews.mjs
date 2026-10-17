#!/usr/bin/env node
// Draws the home screen's board pictures for the deploy, with the site's own 3D code in a headless
// browser:   node tools/render-previews.mjs <built site> <store>
// <built site>: the site after `npm run build` and tools/build-index.mjs (the index is what lists the
// projects and their commits; no GitHub API). <store>: the folder kept on the repo's previews branch,
// laid out as the site serves it (previews/<owner>/<repo>/r<version>/<commit>/<project path>.json). Only pictures
// the store lacks are drawn; every one in the store is then copied into the site, with a list per repo
// (previews/<owner>/<repo>/index.json) of which commit each project's picture is at.
// Env: RENDER_BUDGET_MIN (default 25): no new picture is started after this long, the rest wait for
// the next deploy. RENDER_LIMIT: draw at most this many (a local try-out). RENDER_CHANNEL: a browser
// to use instead of Playwright's own Chromium ("chrome": the installed one).
import { chromium } from "@playwright/test"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, extname, join, normalize } from "node:path"

const [site, store] = process.argv.slice(2)
if (!site || !store) {
	console.error("usage: render-previews.mjs <built site> <store>")
	process.exit(2)
}
const budgetMs = Number(process.env.RENDER_BUDGET_MIN ?? 25) * 60_000
const limit = Number(process.env.RENDER_LIMIT ?? Infinity)
const started = Date.now()

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" }
const server = createServer((req, res) => {
	const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "")
	let file = join(site, path)
	if (!existsSync(file) || path === "") file = join(site, "index.html")
	try {
		const body = readFileSync(file)
		res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
		res.end(body)
	} catch {
		res.writeHead(404).end()
	}
})
await new Promise(done => server.listen(0, "127.0.0.1", done))
const url = `http://127.0.0.1:${server.address().port}/?render-previews#/`

// Software WebGL: the CI machine has no GPU.
const browser = await chromium.launch({ channel: process.env.RENDER_CHANNEL || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
let page = null
const fresh = async () => {
	await page?.close()
	page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
	page.on("pageerror", e => console.log(`  page error: ${e.message}`))
	await page.goto(url)
	await page.waitForFunction(() => typeof window.__previewPlan === "function", null, { timeout: 60_000 })
}

let drawn = 0, failed = 0
let jobs = []
try {
	await fresh()
	jobs = await page.evaluate(() => window.__previewPlan())
	const todo = jobs.filter(j => !existsSync(join(store, j.path)))
	console.log(`${jobs.length} projects, ${jobs.length - todo.length} pictures stored, ${todo.length} to draw`)
	for (const job of todo) {
		if (drawn + failed >= limit) break
		if (Date.now() - started > budgetMs) {
			console.log(`time budget spent: ${todo.length - drawn - failed} left for the next deploy`)
			break
		}
		const t0 = Date.now()
		try {
			// A page per picture: each loads a whole project, and memory is given back between them.
			await fresh()
			const stored = await page.evaluate(j => window.__renderPreview(j), job)
			const out = join(store, job.path)
			mkdirSync(dirname(out), { recursive: true })
			writeFileSync(out, JSON.stringify(stored))
			drawn++
			console.log(`  ${job.repo}/${job.prjPath} @ ${job.sha.slice(0, 7)}: ${"none" in stored ? "no board" : "drawn"} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
		} catch (e) {
			failed++
			console.log(`  ${job.repo}/${job.prjPath} @ ${job.sha.slice(0, 7)}: FAILED ${e instanceof Error ? e.message.split("\n")[0] : e}`)
		}
	}
} finally {
	await browser.close()
	server.close()
}

if (existsSync(join(store, "previews"))) cpSync(join(store, "previews"), join(site, "previews"), { recursive: true })
// Each repo's list (src/app/stored-preview.ts PreviewManifest): per project, the commit its picture is
// at and the folders its history covers, as of the branch head now. The project page reads it to ask
// for its picture straight away and to skip reading the project file.
const manifests = new Map()
for (const j of jobs) {
	const key = `${j.owner}/${j.repo}`
	if (!manifests.has(key)) manifests.set(key, { owner: j.owner, repo: j.repo, branch: j.branch, head: j.head, projects: {} })
	manifests.get(key).projects[j.prjPath] = { sha: j.sha, folders: j.folders }
}
for (const { owner, repo, ...m } of manifests.values()) {
	mkdirSync(join(site, "previews", owner, repo), { recursive: true })
	writeFileSync(join(site, "previews", owner, repo, "index.json"), JSON.stringify(m))
}
console.log(`drew ${drawn}, failed ${failed}`)
