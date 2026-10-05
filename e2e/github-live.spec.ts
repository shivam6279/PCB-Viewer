import { execFileSync } from "node:child_process"
import { expect, test, type Page } from "@playwright/test"
import { CORPUS, hasCorpus } from "../tests/corpus/env"
import { cubliCommits, OWNER, REPO } from "./github-fixture"

// Real api.github.com: the same commit opened from GitHub and from a `git archive` of it must render
// the same. Opt-in: GITHUB_TOKEN=<read-only token> npx playwright test e2e/github-live.spec.ts
const token = process.env.GITHUB_TOKEN
test.skip(!token || !hasCorpus, "set GITHUB_TOKEN (and have the corpus) to run against GitHub")

const FOLDER = "Cubli/Main Board/STM32"
const PRJ = `${FOLDER}/Cubli.PrjPcb`

async function capture(page: Page) {
	const tree = page.getByRole("navigation", { name: "Project" })
	await expect(tree.getByText("Top.SchDoc (Top)", { exact: true })).toBeVisible({ timeout: 120_000 })
	const view = page.locator(".view-area")
	await page.waitForTimeout(1500)
	const sch = await view.screenshot()
	await tree.getByText("Cubli.PcbDoc").click()
	await expect(page.getByLabel("PCB view").locator(".pcb-view")).toBeVisible()
	await page.waitForTimeout(2500)
	const pcb = await view.screenshot()
	return { sch, pcb }
}

test("a commit from GitHub renders exactly like a local archive of it", async ({ page, browser }) => {
	test.setTimeout(300_000)
	const sha = cubliCommits()[1]!

	await page.addInitScript(t => localStorage.setItem("github-token", t), token!)
	await page.goto(`/#/gh/${OWNER}/${REPO}/${sha}/${PRJ.split("/").map(encodeURIComponent).join("/")}`)
	const fromGitHub = await capture(page)

	const local = await browser.newPage()
	await local.goto("/")
	const zip = execFileSync("git", ["archive", "--format=zip", sha, "--", FOLDER], { cwd: CORPUS, maxBuffer: 1 << 30 })
	await local.getByTestId("zip-input").setInputFiles({ name: "Cubli.zip", mimeType: "application/zip", buffer: zip })
	const fromZip = await capture(local)

	expect(fromGitHub.sch.equals(fromZip.sch), "schematic differs").toBe(true)
	expect(fromGitHub.pcb.equals(fromZip.pcb), "PCB differs").toBe(true)
})
