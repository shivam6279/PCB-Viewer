import { expect, test, type Page } from "@playwright/test"
import { hasCorpus } from "../tests/corpus/env"
import { cubliCommits, fakeGitHub, OWNER, REPO } from "./github-fixture"

test.skip(!hasCorpus, "local corpus not available")
test.use({ viewport: { width: 1600, height: 900 } })
test.setTimeout(180_000)

const PRJ = "Cubli/Main Board/STM32/Cubli.PrjPcb"
const shot = async (page: Page, name: string) => {
	if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/compare-${name}.png` })
}

test("compare two commits: badges, primary / secondary / diff, highlights", async ({ page }) => {
	const errors: string[] = []
	page.on("pageerror", e => errors.push(e.message))
	const gh = await fakeGitHub(page)
	await page.addInitScript(t => localStorage.setItem("github-token", t), gh.token)
	// Between these two, the board and ESC_MCU.SchDoc changed (see the corpus history). Named, not taken
	// by position: newer commits to the corpus would otherwise shift which pair is compared.
	const sha = (prefix: string) => cubliCommits().find(c => c.startsWith(prefix))!
	const [middle, oldest] = [sha("4fec765"), sha("033d34e")]
	await page.goto(`/#/gh/${OWNER}/${REPO}/${middle}/${PRJ.split("/").map(encodeURIComponent).join("/")}`)
	const tree = page.getByRole("navigation", { name: "Project" })
	await expect(tree.getByText("Top.SchDoc (Top)", { exact: true })).toBeVisible({ timeout: 60_000 })

	// Compare picks the commit before this one.
	await page.getByRole("button", { name: "Compare" }).click()
	await expect(page).toHaveURL(new RegExp(`[?]vs=${oldest}$`))
	await expect(page.getByLabel("Compare with")).toHaveValue(oldest)
	const modes = page.getByRole("group", { name: "Compare view" })
	await expect(modes.getByRole("button", { name: "Both" })).toBeEnabled({ timeout: 60_000 })
	const note = page.locator(".delta-note, .delta-changes")

	// File badges: the board and the ESC MCU sheets changed, nothing else.
	await expect(tree.locator(".tree-row", { hasText: "Cubli.PcbDoc" }).getByLabel("Changed")).toBeVisible()
	// ESC is a multi-channel sheet: its folded row says something in it changed.
	await expect(tree.locator(".tree-row", { hasText: /^ESC\.SchDoc/ }).getByLabel("Changed")).toBeVisible()
	await tree.getByLabel("Expand ESC.SchDoc").click()
	await expect(tree.locator(".tree-row", { hasText: "ESC_MCU.SchDoc (U_ESC_MCU1)" }).getByLabel("Changed")).toBeVisible()
	await expect(tree.locator(".tree-row", { hasText: "Top.SchDoc (Top)" }).locator(".tree-change")).toHaveCount(0)

	// Both (the default) on a changed sheet: both sides, marks counted, inked groups drawn.
	await tree.getByText("ESC_MCU.SchDoc (U_ESC_MCU1)").click()
	const a = page.getByLabel("Primary (A)"), b = page.getByLabel("Secondary (B)")
	await expect(a.locator('.sch-view[data-status="ready"]')).toBeVisible({ timeout: 60_000 })
	await expect(b.locator('.sch-view[data-status="ready"]')).toBeVisible({ timeout: 60_000 })
	// The differences show on A only: green what only A has, red what only B has; B is plain.
	await expect(note).toHaveText(/differences?|Most/, { timeout: 30_000 })
	expect(await a.locator(".diff-ink").count()).toBeGreaterThan(0)
	await expect(b.locator(".diff-ink")).toHaveCount(0)
	// No deltas: both plain.
	const deltas = page.getByRole("group", { name: "Differences" })
	await deltas.getByRole("button", { name: "No deltas" }).click()
	await expect(a.locator(".diff-ink")).toHaveCount(0)
	await deltas.getByRole("button", { name: "Deltas", exact: true }).click()
	await expect(a.locator(".diff-ink")).not.toHaveCount(0)
	await shot(page, "sch")

	// An unchanged sheet says so.
	await tree.getByText("Top.SchDoc (Top)", { exact: true }).click()
	await expect(note).toHaveText("No changes in this file", { timeout: 30_000 })

	// The board.
	await page.getByRole("tab", { name: "PCB" }).click()
	await expect(a.locator(".pcb-view")).toBeVisible({ timeout: 60_000 })
	// The board's artwork compared: the places that changed, listed; picking one goes there on both.
	const changes = page.getByRole("button", { name: /^\d+ changes? / })
	await expect(changes).toBeVisible({ timeout: 60_000 })
	await page.waitForTimeout(800)
	await shot(page, "pcb")
	await changes.click()
	const list = page.getByRole("menu", { name: "Changes" })
	await expect(list.getByRole("menuitem")).not.toHaveCount(0)
	const scale = (pane: typeof a) => pane.locator(".pcb-canvas").evaluate(el => (el as any).__pcb.camera().scale as number)
	const before = await scale(a)
	await list.getByRole("menuitem").first().click()
	await expect.poll(() => scale(a)).toBeGreaterThan(before * 3)
	expect(Math.abs((await scale(b)) / (await scale(a)) - 1)).toBeLessThan(0.01)
	await shot(page, "pcb-change")
	await page.keyboard.press("Escape")
	await expect(list).toHaveCount(0)

	// One layer panel for both boards (opened from the doc bar), in a column of its own beside them
	// (covering neither); both boards follow it.
	await page.getByRole("button", { name: "Layers/Objects" }).click()
	await expect(page.getByRole("complementary", { name: "Layers and objects" })).toHaveCount(1)
	await expect(page.locator(".diff-panel-host").getByRole("complementary", { name: "Layers and objects" })).toBeVisible()
	const panelBox = (await page.locator(".diff-panel-host").boundingBox())!
	const paneBox = (await a.boundingBox())!
	expect(paneBox.x).toBeGreaterThanOrEqual(panelBox.x + panelBox.width - 1)
	await page.getByRole("radio", { name: "Current only" }).click() // Top is current
	await page.waitForTimeout(600)
	await shot(page, "pcb-top-only")
	const onlyOn = (pane: typeof a) => pane.locator(".pcb-canvas").evaluate(el => (el as any).__pcb.layers?.()?.mode === "only" ? (el as any).__pcb.layers().current : null)
	expect(await onlyOn(a)).toBe("TOP")
	expect(await onlyOn(b)).toBe("TOP")
	// The doc bar button closes and reopens it.
	await page.getByRole("button", { name: "Layers/Objects" }).click()
	await expect(page.getByRole("complementary", { name: "Layers and objects" })).toHaveCount(0)
	await page.getByRole("button", { name: "Layers/Objects" }).click()
	await expect(page.getByRole("complementary", { name: "Layers and objects" })).toHaveCount(1)

	// Secondary shows the other commit alone, its differences against the primary marked; Primary
	// returns, marked against the secondary. The list is there in both.
	await modes.getByRole("button", { name: "Secondary" }).click()
	await expect(page.getByLabel("Primary (A)")).toHaveCount(0)
	await expect(page.locator(".pcb-view")).toBeVisible({ timeout: 60_000 })
	await expect(page.locator(".diff-legend")).toHaveText(/only in B\s*only in A/)
	await expect(changes).toBeVisible({ timeout: 60_000 })
	await shot(page, "secondary")
	await modes.getByRole("button", { name: "Primary" }).click()
	await expect(page.locator(".pcb-view")).toBeVisible()
	await expect(page.locator(".diff-legend")).toHaveText(/only in A\s*only in B/)
	await expect(changes).toBeVisible({ timeout: 60_000 })
	await shot(page, "primary")

	// Stop comparing.
	await page.getByRole("button", { name: "Stop comparing" }).click()
	await expect(page).not.toHaveURL(/vs=/)
	await expect(modes).toHaveCount(0)
	await expect(tree.locator(".tree-change")).toHaveCount(0)
	expect(errors).toEqual([])
})
