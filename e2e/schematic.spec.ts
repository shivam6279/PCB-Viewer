import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { hasCorpus } from "../tests/corpus/env"
import { CUBLI_DIR, zipTopLevel } from "./fixtures"

// Set SHOTS_DIR to save one screenshot per sheet for visual review.
const SHOTS_DIR = process.env.SHOTS_DIR

test.skip(!hasCorpus, "local corpus not available")
test.use({ viewport: { width: 1600, height: 900 } })

async function openCubli(page: Page) {
	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: "Cubli.zip", mimeType: "application/zip", buffer: zipTopLevel(CUBLI_DIR) })
	await expect(page.getByRole("navigation", { name: "Project" }).getByText("Top.SchDoc (Top)", { exact: true })).toBeVisible()
}

const readyView = (page: Page) => page.locator('.sch-view[data-status="ready"] svg')

test("every sheet in the hierarchy renders a drawn schematic", async ({ page }) => {
	const errors: string[] = []
	page.on("pageerror", e => errors.push(e.message))
	await openCubli(page)

	const rows = page.locator(".sidebar .tree-row:has(.tree-icon.sch)")
	const count = await rows.count()
	expect(count).toBeGreaterThan(5)
	for (let i = 0; i < count; i++) {
		const row = rows.nth(i)
		const label = (await row.innerText()).trim()
		const fileName = label.replace(/\s*\(.*$/, "")
		await row.click()
		// Wait for THIS sheet (not the previous one) to be on screen.
		const nodeId = await page.getByLabel("Sheet", { exact: true }).inputValue()
		const view = page.locator(`.sch-view[data-node="${nodeId}"][data-status="ready"]`)
		await expect(view).toBeVisible({ timeout: 30_000 })
		const records = await view.locator("svg [data-record]").count()
		expect(records, `${label} drew ${records} records`).toBeGreaterThan(20)
		// The title block names the file that was drawn, so a stale sheet can't pass.
		await expect(view.locator('g[data-record="TitleBlock"] text', { hasText: fileName })).toHaveCount(1)
		if (SHOTS_DIR) await page.screenshot({ path: join(SHOTS_DIR, `sheet-${String(i).padStart(2, "0")}.png`) })
	}
	expect(errors).toEqual([])
})

test("wheel zooms at the cursor, drag pans, double-click does not refit", async ({ page }) => {
	await openCubli(page)
	await expect(readyView(page)).toBeVisible()
	const svg = readyView(page)
	const box = (await page.locator(".sch-view").boundingBox())!
	const viewBox = async () => (await svg.getAttribute("viewBox"))!.split(" ").map(Number)

	const fitted = await viewBox()
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	await page.mouse.wheel(0, -600)
	const zoomed = await viewBox()
	expect(zoomed[2]!).toBeLessThan(fitted[2]! * 0.7)

	await page.mouse.down()
	await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 100, { steps: 5 })
	await page.mouse.up()
	const panned = await viewBox()
	expect(panned[0]!).toBeLessThan(zoomed[0]!)
	expect(panned[2]).toBeCloseTo(zoomed[2]!)

	const before = await viewBox()
	await page.mouse.dblclick(box.x + 50, box.y + 50)
	expect(await viewBox()).toEqual(before)
	expect(before).not.toEqual(fitted)
})
