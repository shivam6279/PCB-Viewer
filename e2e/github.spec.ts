import { expect, test, type Page } from "@playwright/test"
import { hasCorpus } from "../tests/corpus/env"
import { cubliCommits, fakeGitHub, headSha, OWNER, REPO, serveIndex } from "./github-fixture"

test.skip(!hasCorpus, "local corpus not available")

const PRJ = "Cubli/Main Board/STM32/Cubli.PrjPcb"
const shot = async (page: Page, name: string) => {
	if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/github-${name}.png` })
}

test("signing in is optional; a bad token is refused in place, a good one shows the account", async ({ page }) => {
	const gh = await fakeGitHub(page)
	await page.goto("/")
	await page.getByRole("button", { name: "Sign in" }).click()
	await page.getByLabel("GitHub token").fill("github_pat_wrong")
	await page.getByRole("button", { name: "Connect GitHub" }).click()
	await expect(page.getByText(/GitHub didn't accept that token/)).toBeVisible()
	await page.getByLabel("GitHub token").fill(gh.token)
	await page.getByRole("button", { name: "Connect GitHub" }).click()
	await expect(page.locator(".account-name")).toHaveText(OWNER)
	await expect(page.getByRole("tree", { name: "GitHub projects" }).getByRole("treeitem", { name: "Cubli", exact: true })).toBeVisible({ timeout: 30_000 })
})

test("no sign-in: browse the public projects, open commits, switch, go back, deep link", async ({ page }) => {
	const errors: string[] = []
	page.on("pageerror", e => errors.push(e.message))
	const gh = await fakeGitHub(page)
	const [newest, older] = cubliCommits() as [string, string]

	// Nobody signs in: the owner's public projects are there from the start.
	await page.goto("/")
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()

	// Home: the repo's projects as its folders nest; folders open on click, search filters.
	const tree = page.getByRole("tree", { name: "GitHub projects" })
	await expect(tree.getByRole("treeitem", { name: "Cubli", exact: true })).toBeVisible({ timeout: 30_000 })
	await tree.getByRole("treeitem", { name: "Cubli", exact: true }).click()
	await expect(tree.getByRole("treeitem", { name: "Charger", exact: true })).toBeVisible()
	await shot(page, "home")
	await page.getByLabel("Search projects").fill("Main Board/STM32")
	await expect(tree.getByRole("treeitem")).toHaveCount(3) // Cubli > Main Board > STM32 (the one repo's folders are the top level)
	await tree.getByRole("treeitem", { name: /^STM32/ }).click()

	// Project page: the history of that folder.
	await expect(page).toHaveURL(new RegExp(`#/gh/${OWNER}/${REPO}/project/Cubli/Main%20Board/STM32/Cubli.PrjPcb$`))
	const list = page.getByRole("list", { name: "Commits" })
	await expect(list.getByRole("listitem")).toHaveCount(cubliCommits().length)
	await shot(page, "project")
	await list.getByText(older.slice(0, 7)).click()

	// Viewer at that commit.
	await expect(page).toHaveURL(new RegExp(`#/gh/${OWNER}/${REPO}/${older}/`))
	const projectTree = page.getByRole("navigation", { name: "Project" })
	await expect(projectTree.getByText("Top.SchDoc (Top)", { exact: true })).toBeVisible({ timeout: 60_000 })
	await expect(page.getByLabel("Commit")).toHaveValue(older)
	await shot(page, "viewer-older")

	// Switch commit from the top bar; unchanged files come from the cache.
	expect(gh.requests.filter(r => r.includes("/git/blobs/"))).toEqual([]) // anonymous: files come from the CDN
	const blobsBefore = gh.requests.filter(r => r.startsWith("raw:")).length
	await page.getByLabel("Commit").selectOption(newest)
	await expect(page).toHaveURL(new RegExp(`#/gh/${OWNER}/${REPO}/${newest}/`))
	await expect(projectTree.getByText("Top.SchDoc (Top)", { exact: true })).toBeVisible({ timeout: 60_000 })
	const blobsAfter = gh.requests.filter(r => r.startsWith("raw:")).length
	const uniqueBlobs = new Set(gh.requests.filter(r => r.startsWith("raw:"))).size
	expect(uniqueBlobs).toBe(blobsAfter) // nothing fetched twice
	expect(blobsAfter).toBeGreaterThanOrEqual(blobsBefore)

	// Back returns to the older commit, then to the project page.
	await page.goBack()
	await expect(page.getByLabel("Commit")).toHaveValue(older, { timeout: 60_000 })
	await page.getByLabel("Back to start").click()
	await expect(page.getByRole("list", { name: "Commits" })).toBeVisible()

	// A fresh load of a deep link (the token is remembered).
	await page.goto(`/#/gh/${OWNER}/${REPO}/${newest}/${PRJ.split("/").map(encodeURIComponent).join("/")}`)
	await page.reload() // a fresh load of the link, still without signing in
	await expect(page.getByRole("navigation", { name: "Project" }).getByText("Top.SchDoc (Top)", { exact: true })).toBeVisible({ timeout: 60_000 })
	await expect(page.getByLabel("Commit")).toHaveValue(newest)
	expect(errors).toEqual([])
})

test("opening a commit shows progress where it was clicked", async ({ page }) => {
	const gh = await fakeGitHub(page)
	await page.addInitScript(t => localStorage.setItem("github-token", t), gh.token)
	const [newest, older] = cubliCommits() as [string, string]
	await page.goto(`/#/gh/${OWNER}/${REPO}/project/${PRJ.split("/").map(encodeURIComponent).join("/")}`)
	const list = page.getByRole("list", { name: "Commits" })
	await expect(list.getByRole("listitem").first()).toBeVisible({ timeout: 30_000 })

	// Project page: the clicked row turns busy with a file count; the page stays.
	gh.blobDelayMs = 1500
	await list.getByText(older.slice(0, 7)).click()
	const row = list.getByRole("listitem").filter({ has: page.getByRole("status") })
	await expect(row).toHaveAttribute("aria-busy", "true")
	await expect(row.getByRole("status")).toHaveText(/of \d+ files|Listing files/)
	await shot(page, "opening-row")
	await expect(page.getByRole("navigation", { name: "Project" }).getByText("Top.SchDoc (Top)", { exact: true })).toBeVisible({ timeout: 60_000 })

	// Viewer: switching commits shows progress beside the picker, over the old commit.
	await page.getByLabel("Commit").selectOption(newest)
	await expect(page.locator(".commit-switcher").getByRole("status")).toBeVisible()
	await shot(page, "opening-switch")
	await expect(page.locator(".commit-switcher").getByRole("status")).toBeHidden({ timeout: 60_000 })
	await expect(page.getByLabel("Commit")).toHaveValue(newest)
})

test("home keeps the open viewer to return to; double-click opens a project's latest commit", async ({ page }) => {
	const gh = await fakeGitHub(page)
	await page.addInitScript(t => localStorage.setItem("github-token", t), gh.token)
	const [, older] = cubliCommits() as [string, string]
	const head = headSha() // "latest" is the branch head, which need not touch the project
	await page.goto(`/#/gh/${OWNER}/${REPO}/${older}/${PRJ.split("/").map(encodeURIComponent).join("/")}`)
	await expect(page.getByRole("navigation", { name: "Project" }).getByText("Top.SchDoc (Top)", { exact: true })).toBeVisible({ timeout: 60_000 })
	await page.getByRole("tab", { name: "PCB" }).click()
	await expect(page.getByRole("tab", { name: "PCB" })).toHaveAttribute("aria-selected", "true")

	// Back to home: the viewer is offered back, and comes back as it was, without reloading anything.
	await page.getByLabel("Back to start").click()
	await expect(page.locator(".home-topbar").getByRole("button", { name: "Return to Cubli" })).toBeVisible()
	await shot(page, "home-parked")
	await page.locator(".home-topbar").getByRole("button", { name: "Return to Cubli" }).click()
	await expect(page.getByRole("tab", { name: "PCB" })).toHaveAttribute("aria-selected", "true")
	await expect(page.getByLabel("Commit", { exact: true })).toHaveValue(older)
	// (A reload would have reset the tab to SCH: the PCB tab still being selected shows it came back as it was.)

	// Double-clicking a project in the tree opens its latest commit, replacing the parked one.
	await page.getByLabel("Back to start").click()
	await page.getByLabel("Search projects").fill("Main Board/STM32")
	await page.getByRole("tree", { name: "GitHub projects" }).getByRole("treeitem", { name: /^STM32/ }).dblclick()
	await expect(page).toHaveURL(new RegExp(`#/gh/${OWNER}/${REPO}/${head}/`))
	await expect(page.getByLabel("Commit", { exact: true })).toHaveValue(head, { timeout: 60_000 })
	await expect(page.getByRole("tab", { name: "SCH" })).toHaveAttribute("aria-selected", "true")
	await page.getByLabel("Back to start").click()
	await expect(page.locator(".home-sidebar .tree-row.active", { hasText: "Cubli" }).first()).toBeVisible()
	await expect(page.locator(".home-topbar").getByRole("button", { name: "Return to Cubli" })).toBeVisible()
})

test("a first anonymous visit stays well inside GitHub's 60 requests an hour", async ({ page }) => {
	const gh = await fakeGitHub(page)
	await page.goto("/")
	// Nothing saved: the repo's folders are the top level, closed; no repo list is fetched.
	const tree = page.getByRole("tree", { name: "GitHub projects" })
	await expect(tree.getByRole("treeitem", { name: "Cubli", exact: true })).toHaveAttribute("aria-expanded", "false", { timeout: 30_000 })
	await expect(tree.getByRole("treeitem", { name: "PCB", exact: true })).toHaveCount(0)
	expect(gh.requests.some(r => r.includes("/repos?"))).toBe(false)
	const home = gh.requests.filter(r => !r.startsWith("raw:")).length
	await page.getByLabel("Search projects").fill("Main Board/STM32")
	await tree.getByRole("treeitem", { name: /^STM32/ }).click()
	await expect(page.getByRole("list", { name: "Commits" }).getByRole("listitem").first()).toBeVisible({ timeout: 30_000 })
	await page.getByRole("list", { name: "Commits" }).getByRole("listitem").first().click()
	await expect(page.locator('.sch-view[data-status="ready"]')).toBeVisible({ timeout: 60_000 })
	await page.waitForTimeout(1500)
	const api = gh.requests.filter(r => !r.startsWith("raw:"))
	console.log(`API requests: home ${home}, through to a commit ${api.length}\n${api.join("\n")}`)
	expect(home).toBeLessThanOrEqual(3)
	expect(api.length).toBeLessThanOrEqual(12)
})

test("with the site's index, browsing makes no GitHub API requests at all", async ({ page }) => {
	const gh = await fakeGitHub(page)
	const served = await serveIndex(page)
	await page.goto("/")
	const tree = page.getByRole("tree", { name: "GitHub projects" })
	await expect(tree.getByRole("treeitem", { name: "Cubli", exact: true })).toBeVisible({ timeout: 30_000 })
	await page.getByLabel("Search projects").fill("Main Board/STM32")
	await tree.getByRole("treeitem", { name: /^STM32/ }).click()
	const list = page.getByRole("list", { name: "Commits" })
	await expect(list.getByRole("listitem")).toHaveCount(cubliCommits().length, { timeout: 30_000 })
	await list.getByRole("listitem").nth(1).click()
	await expect(page.locator('.sch-view[data-status="ready"]')).toBeVisible({ timeout: 60_000 })
	// Compare with the commit before: still nothing from the API.
	await page.getByRole("button", { name: "Compare" }).click()
	await expect(page.getByRole("group", { name: "Compare view" }).getByRole("button", { name: "Diff" })).toBeEnabled({ timeout: 60_000 })
	await page.waitForTimeout(1000)
	const api = gh.requests.filter(r => !r.startsWith("raw:"))
	expect(served).toContain("shivam6279/PCB/commits.json")
	expect(api).toEqual([])
	expect(gh.requests.filter(r => r.startsWith("raw:")).length).toBeGreaterThan(0) // files from the CDN
})
