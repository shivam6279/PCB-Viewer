import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { CORPUS, hasCorpus } from "../tests/corpus/env"
import { CUBLI_DIR, zipTopLevel } from "./fixtures"

const SHOTS_DIR = process.env.SHOTS_DIR
const shot = async (page: Page, name: string) => {
	if (SHOTS_DIR) await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) })
}

test.skip(!hasCorpus, "local corpus not available")
test.use({ viewport: { width: 1905, height: 916 } })
test.setTimeout(120_000)

async function openBom(page: Page, dir: string, name: string) {
	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: `${name}.zip`, mimeType: "application/zip", buffer: zipTopLevel(dir, name) })
	await expect(page.locator('.sch-view[data-status="ready"][data-compiled="true"]')).toBeVisible({ timeout: 60_000 })
	await page.getByRole("tab", { name: "BOM" }).click()
	await expect(page.locator(".bom-table")).toBeVisible()
}

test("a board without a BOM document: lines from the board's parts, compiled designators", async ({ page }) => {
	await openBom(page, CUBLI_DIR, "STM32")
	await expect(page.locator(".bom-source")).toHaveText("Parts from the board")
	// Channel copies carry their compiled names, each once.
	const designators = await page.locator(".bom-designator").allTextContents()
	expect(designators).toContain("U13_ESC_1")
	expect(new Set(designators).size).toBe(designators.length)
	await shot(page, "bom-cubli")

	// A designator selects its part.
	await page.locator(".bom-designator", { hasText: /^U13_ESC_1$/ }).click()
	await expect(page.locator(".inspector")).toContainText("U13_ESC_1")
	await expect(page.locator(".bom-designator.on")).toHaveText("U13_ESC_1")

	// The filter narrows the lines.
	const all = await page.locator(".bom-table tbody tr").count()
	await page.getByRole("searchbox", { name: "Filter BOM" }).fill("U13_ESC_1")
	await expect(page.locator(".bom-table tbody tr")).toHaveCount(1)
	expect(all).toBeGreaterThan(10)

	// CSV export.
	const download = page.waitForEvent("download")
	await page.getByRole("button", { name: "CSV" }).click()
	const file = await download
	expect(file.suggestedFilename()).toMatch(/BOM\.csv$/)
})

test("a BOM document fills in descriptions and manufacturer parts", async ({ page }) => {
	await openBom(page, join(CORPUS, "POV/POVRotor/Rev3"), "POVRotor")
	await expect(page.locator(".bom-source")).toContainText("items from POVRotor.BomDoc")
	await expect(page.locator(".bom-table th", { hasText: "Manufacturer Part Number" })).toBeVisible()
	// Every line of that item carries its chosen manufacturer part.
	const rows = page.locator(".bom-table tbody tr", { hasText: "C1005X5R1E104K" })
	expect(await rows.count()).toBeGreaterThan(0)
	for (const row of await rows.all()) await expect(row).toContainText("TDK")
	await shot(page, "bom-povrotor")
})

// Opens a project, then a part from the BOM: the inspector shows its footprint picture.
async function footprintOf(page: Page, dir: string, name: string, designator: string) {
	await openBom(page, dir, name)
	await page.getByRole("searchbox", { name: "Filter BOM" }).fill(designator)
	await page.locator(".bom-designator", { hasText: new RegExp(`^${designator}$`) }).first().click()
	const picture = page.locator(".inspector .footprint-picture")
	await expect(picture.locator("svg g[data-layer]").first()).toBeAttached()
	return picture
}

test("the footprint picture shows the part's copper, as designed (0°)", async ({ page }) => {
	// LED_ring's LEDs: copper pads in the picture.
	const led = await footprintOf(page, join(CORPUS, "PnP/LED_ring"), "led_ring", "D1")
	expect(await led.locator('svg g[data-layer="TOP"] > *').count()).toBeGreaterThan(0)
	await shot(page, "footprint-led")
	// D1..D3 sit at 180°, 120° and 60°: one footprint, one picture.
	const first = await led.innerHTML()
	await page.getByRole("searchbox", { name: "Filter BOM" }).fill("")
	for (const d of ["D2", "D3"]) {
		await page.locator(".bom-designator", { hasText: new RegExp(`^${d}$`) }).click()
		await expect(page.locator(".inspector .inspector-head .title")).toHaveText(d)
		expect(await page.locator(".inspector .footprint-picture").innerHTML()).toBe(first)
	}
})

test("a part turned on the board shows upright in its footprint picture", async ({ page }) => {
	// Charger's R30 sits at 51.1° on the board; in its picture its two pads sit level, side by side.
	const r = await footprintOf(page, join(CORPUS, "Cubli/Charger"), "Charger", "R30")
	const pads = await r.locator('svg g[data-layer="TOP"] > *').evaluateAll(els =>
		els.map(el => {
			const b = el.getBoundingClientRect()
			return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
		}),
	)
	expect(pads).toHaveLength(2)
	expect(Math.abs(pads[0]!.y - pads[1]!.y)).toBeLessThan(0.5)
	expect(Math.abs(pads[0]!.x - pads[1]!.x)).toBeGreaterThan(20)
	await shot(page, "footprint-r30")
})
