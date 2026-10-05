import { expect, test } from "@playwright/test"
import { hasCorpus } from "../tests/corpus/env"
import { CUBLI_DIR, zipTopLevel } from "./fixtures"

test.skip(!hasCorpus, "local corpus not available")

test("opening a zip parses in the worker and shows the project tree", async ({ page }) => {
	const errors: string[] = []
	page.on("pageerror", e => errors.push(e.message))

	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: "Cubli.zip", mimeType: "application/zip", buffer: zipTopLevel(CUBLI_DIR) })

	const tree = page.getByRole("navigation", { name: "Project" })
	await expect(tree.getByText("Top.SchDoc (Top)", { exact: true })).toBeVisible()
	await expect(tree.getByText("ESC.SchDoc (U_ESC2)")).toBeVisible()
	await expect(tree.getByText("Cubli.PcbDoc")).toBeVisible()

	await tree.getByText("Cubli.PcbDoc").click()
	await expect(page.getByRole("tab", { name: "PCB" })).toHaveAttribute("aria-selected", "true")
	await expect(page.getByLabel("PCB view").locator(".pcb-view")).toBeVisible()

	await page.getByLabel("Back to start").click()
	await expect(page.getByText(/Drop an Altium project folder/)).toBeVisible()
	expect(errors).toEqual([])
})
