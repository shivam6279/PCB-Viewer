import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { hasCorpus } from "../tests/corpus/env"
import { CUBLI_DIR, zipTopLevel } from "./fixtures"

const SHOTS_DIR = process.env.SHOTS_DIR

test.skip(!hasCorpus, "local corpus not available")
test.use({ viewport: { width: 1600, height: 900 } })

test("Export STEP asks for its settings, then saves the board as a STEP assembly: board, copper, solder mask, silkscreen and every part", async ({ page }) => {
	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: "Cubli.zip", mimeType: "application/zip", buffer: zipTopLevel(CUBLI_DIR) })
	await expect(page.locator('.sch-view[data-status="ready"][data-compiled="true"]')).toBeVisible({ timeout: 60_000 })
	await page.getByRole("tab", { name: "3D" }).click()
	await expect(page.locator('.view3d[data-status="ready"]')).toBeVisible({ timeout: 120_000 })

	await page.getByRole("button", { name: "Export STEP" }).click()
	const dialog = page.getByRole("dialog", { name: "Export STEP" })
	await expect(dialog).toBeVisible()
	// Vias are left solid unless asked; the rest is on.
	for (const name of ["Drill via holes", "Copper under the solder mask"]) await expect(dialog.getByRole("checkbox", { name, exact: true })).not.toBeChecked()
	for (const name of ["Parts", "Copper", "Plated holes", "Solder mask", "Silkscreen"]) await expect(dialog.getByRole("checkbox", { name, exact: true })).toBeChecked()
	// A preview of the settings, and the file's size worked out from the board.
	await expect(dialog.getByRole("img", { name: "Preview of the export" })).toBeVisible()
	await expect(dialog.getByRole("status")).toHaveText(/^Estimated size: \d+(\.\d)? (MB|KB)$/, { timeout: 120_000 })
	await expect(dialog.getByRole("slider")).toHaveAttribute("aria-valuetext", "Fine")
	// The copper under the mask only matters with both drawn.
	await dialog.getByRole("checkbox", { name: "Solder mask", exact: true }).uncheck()
	await expect(dialog.getByRole("checkbox", { name: "Copper under the solder mask", exact: true })).toBeDisabled()
	await dialog.getByRole("checkbox", { name: "Solder mask", exact: true }).check()
	if (SHOTS_DIR) await page.screenshot({ path: join(SHOTS_DIR, "step-dialog.png") })
	const download = page.waitForEvent("download", { timeout: 120_000 })
	await dialog.getByRole("button", { name: "Export" }).click()
	await expect(dialog).toHaveCount(0)
	const file = await download
	expect(file.suggestedFilename()).toBe("Cubli.step")
	const path = SHOTS_DIR ? join(SHOTS_DIR, "Cubli.step") : await file.path()
	if (SHOTS_DIR) await file.saveAs(path)
	const text = readFileSync(path, "latin1")
	expect(text.startsWith("ISO-10303-21;")).toBe(true)
	expect(text.trimEnd().endsWith("END-ISO-10303-21;")).toBe(true)
	// One assembly instance per part, plus the board itself.
	const instances = [...text.matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('\d+','([^']*)'/g)].map(m => m[1])
	expect(instances).toEqual(expect.arrayContaining(["Board", "Top Copper", "Bottom Copper", "Plated Holes", "Top Solder Mask", "Bottom Solder Mask", "Top Silkscreen", "Bottom Silkscreen"]))
	expect(instances).toContain("U13_ESC")
	expect(instances.length).toBeGreaterThan(400)
	await expect(page.getByRole("button", { name: "Export STEP" })).toBeEnabled()
})
