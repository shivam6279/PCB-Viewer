import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { hasCorpus } from "../tests/corpus/env"
import { CUBLI_DIR, zipTopLevel } from "./fixtures"

const SHOTS_DIR = process.env.SHOTS_DIR

test.skip(!hasCorpus, "local corpus not available")
test.use({ viewport: { width: 1600, height: 900 } })

async function openCubli(page: Page) {
	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: "Cubli.zip", mimeType: "application/zip", buffer: zipTopLevel(CUBLI_DIR) })
	await expect(page.getByRole("navigation", { name: "Project" }).getByText("Top.SchDoc (Top)", { exact: true })).toBeVisible()
}

test("the project opens on its first variant; its not-fitted parts are greyed and crossed out", async ({ page }) => {
	await openCubli(page)
	const tree = page.getByRole("navigation", { name: "Project" })
	await expect(tree.getByText("Variants", { exact: true })).toBeVisible()
	const main = tree.locator(".tree-row", { has: page.getByText("Main", { exact: true }) })
	await expect(main).toHaveClass(/checked/)
	await expect(tree.locator(".tree-row", { has: page.getByText("[No Variations]", { exact: true }) })).not.toHaveClass(/checked/)

	// R7_ESC_1 and R8_ESC_1 (0R) are not fitted in Main.
	await tree.getByText("ESC.SchDoc (U_ESC1)", { exact: true }).click()
	const view = page.locator('.sch-view[data-node$="U_ESC1"][data-status="ready"][data-compiled="true"]')
	await expect(view).toBeVisible({ timeout: 60_000 })
	await expect(view).toHaveAttribute("data-not-fitted", "2")
	await expect(view.locator(".sch-not-fitted line")).toHaveCount(4)
	expect(await view.locator("g.not-fitted").count()).toBeGreaterThan(2)
	if (SHOTS_DIR) {
		const cross = await view.locator(".sch-not-fitted line").first().boundingBox()
		await page.screenshot({ path: join(SHOTS_DIR, "variant-main.png") })
		if (cross) await page.screenshot({ path: join(SHOTS_DIR, "variant-main-zoom.png"), clip: { x: cross.x - 150, y: cross.y - 80, width: 360, height: 200 } })
	}

	await tree.getByText("[No Variations]", { exact: true }).click()
	await expect(view).toHaveAttribute("data-not-fitted", "0")
	await expect(view.locator(".sch-not-fitted line")).toHaveCount(0)
	await expect(view.locator("g.not-fitted")).toHaveCount(0)
	if (SHOTS_DIR) await page.screenshot({ path: join(SHOTS_DIR, "variant-none.png") })
})

test("the variant's not-fitted parts have no body in 3D", async ({ page }) => {
	await openCubli(page)
	await expect(page.locator('.sch-view[data-status="ready"][data-compiled="true"]')).toBeVisible({ timeout: 60_000 })
	await page.getByRole("tab", { name: "3D" }).click()
	await expect(page.locator('.view3d[data-status="ready"]')).toBeVisible({ timeout: 120_000 })
	const canvas = page.locator(".view3d-canvas")
	const shown = () => page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.parts.children.filter((m: any) => m.visible).length as number)
	const total = () => page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.parts.children.length as number)

	// Main: R7 and R8 of each of the three ESC channels are not fitted.
	await expect(canvas).toHaveAttribute("data-not-fitted", "6")
	const all = await total()
	expect(await shown()).toBe(all - 6)

	const tree = page.getByRole("navigation", { name: "Project" })
	await tree.getByText("[No Variations]", { exact: true }).click()
	await expect(canvas).toHaveAttribute("data-not-fitted", "0")
	expect(await shown()).toBe(all)
})
