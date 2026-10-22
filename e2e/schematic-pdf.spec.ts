import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { hasCorpus } from "../tests/corpus/env"
import { CUBLI_DIR, zipTopLevel } from "./fixtures"

const SHOTS_DIR = process.env.SHOTS_DIR

test.skip(!hasCorpus, "local corpus not available")
test.use({ viewport: { width: 1600, height: 900 } })

test("Export PDF: every sheet instance a page, ports, entries and symbols linking across, parts and nets opening menus", async ({ page, context }) => {
	// The sheets' own fonts are embedded when the browser may read this computer's fonts.
	await context.grantPermissions(["local-fonts"])
	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: "Cubli.zip", mimeType: "application/zip", buffer: zipTopLevel(CUBLI_DIR) })
	await expect(page.locator('.sch-view[data-status="ready"][data-compiled="true"]')).toBeVisible({ timeout: 60_000 })
	await page.getByRole("button", { name: "Sheet" }).click()
	const sheets = await page.getByRole("listbox", { name: "Sheets" }).getByRole("option").count()
	await page.getByRole("button", { name: "Sheet" }).click()

	// The settings first: net colours on, a page per channel, unless changed.
	await page.getByRole("button", { name: "Export PDF" }).click()
	const dialog = page.getByRole("dialog", { name: "Export PDF" })
	await expect(dialog.getByRole("checkbox", { name: "Net colours" })).toBeChecked()
	await expect(dialog.getByRole("radio", { name: /^Physical/ })).toBeChecked()
	if (SHOTS_DIR) await page.screenshot({ path: join(SHOTS_DIR, "sch-pdf-dialog.png") })
	const download = page.waitForEvent("download", { timeout: 180_000 })
	await dialog.getByRole("button", { name: "Export" }).click()
	await expect(dialog).toHaveCount(0)
	const file = await download
	expect(file.suggestedFilename()).toBe("Cubli.pdf")
	const path = SHOTS_DIR ? join(SHOTS_DIR, "Cubli.pdf") : await file.path()
	if (SHOTS_DIR) await file.saveAs(path)
	await expect(page.getByRole("button", { name: "Export PDF" })).toBeEnabled()

	const pdf = readFileSync(path, "latin1")
	expect(pdf.startsWith("%PDF-")).toBe(true)
	const pages = pdf.match(/\/Type \/Page\b(?!s)/g)?.length ?? 0
	expect(sheets).toBeGreaterThan(5)
	expect(pages).toBe(sheets)
	// Parts and nets open a menu (the document's script); ports and sheet symbols jump.
	expect(pdf).toMatch(/\/S \/JavaScript \/JS \(P\(this,\d+\); *\)/)
	expect(pdf).toMatch(/\/S \/JavaScript \/JS \(N\(this,\d+\); *\)/)
	expect(pdf).toContain("var PCBV_PARTS=[") // the document's script (its parentheses are escaped in the file)
	expect(pdf).not.toContain("pcbv-js:")
	// Links within the document, and bookmarks for the sheets.
	expect(pdf.match(/\/Subtype \/Link [^>]*\/Dest \[/g)?.length ?? 0).toBeGreaterThan(300) // ports, entries, symbols
	// A net's menu goes to named destinations fitted to the net on each sheet.
	expect(pdf).toMatch(/\/Dests \d+ 0 R/)
	expect(pdf).toMatch(/\/pcbv_n\d+_0 \[\d+ 0 R \/FitR [\d. ]+\]/)
	expect(pdf).toContain("/Outlines")
	expect(pdf).toContain("/BaseFont /emb-consolas")
	expect(pdf.match(/\/FontFile2/g)?.length ?? 0).toBeGreaterThan(1)

	// Title-block expressions are worked out in the view (and so in the PDF): =Copy(DocumentName, ...).
	const title = page.locator('.sch-view[data-status="ready"] text').filter({ hasText: /^Sheet \d+ of \d+$/ })
	await expect(title).toHaveCount(1)
	await expect(page.locator('.sch-view[data-status="ready"] text').filter({ hasText: /^=/ })).toHaveCount(0)
})

test("Export PDF, logical: one page per schematic document, names with * for each instance's part, a note of what * is", async ({ page }) => {
	await page.context().grantPermissions(["local-fonts"])
	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: "Cubli.zip", mimeType: "application/zip", buffer: zipTopLevel(CUBLI_DIR) })
	await expect(page.locator('.sch-view[data-status="ready"][data-compiled="true"]')).toBeVisible({ timeout: 60_000 })
	await page.getByRole("button", { name: "Export PDF" }).click()
	const dialog = page.getByRole("dialog", { name: "Export PDF" })
	await dialog.getByRole("radio", { name: /^Logical/ }).check()
	await dialog.getByRole("checkbox", { name: "Net colours" }).uncheck()
	const download = page.waitForEvent("download", { timeout: 180_000 })
	await dialog.getByRole("button", { name: "Export" }).click()
	const file = await download
	const path = SHOTS_DIR ? join(SHOTS_DIR, "Cubli-grouped.pdf") : await file.path()
	if (SHOTS_DIR) await file.saveAs(path)
	const pdf = readFileSync(path, "latin1")
	// Cubli: Top, ESC, ESC_MCU, ESC_Power, Half_Bridges, Main_MCU, Power: 7 sheet pages.
	// Bookmarks: "/Title (ESC \(U_ESC1\))" ... "/Dest [<page object> 0 R".
	const marks = [...pdf.matchAll(/\/Title \(((?:\\.|[^\\)])*)\)[^>]*?\/Dest \[(\d+) 0 R/g)].map(m => ({ title: m[1]!.replaceAll(/\\(.)/g, "$1"), page: m[2] }))
	expect(marks.map(m => m.title)).toEqual(expect.arrayContaining(["ESC (U_ESC1)", "ESC (U_ESC2)", "ESC (U_ESC3)"]))
	const destOf = (title: string) => marks.find(m => m.title === title)?.page
	expect(new Set(["Top (Top)", "ESC (U_ESC1)", "ESC_MCU (U_ESC_MCU1)", "ESC_Power (U_Power1)", "Half_Bridges (U_Half_Bridges1)", "Main_MCU (U_Main_MCU)", "Power (U_Power)"].map(destOf)).size).toBe(7)
	expect(destOf("ESC_MCU (U_ESC_MCU2)")).toBe(destOf("ESC_MCU (U_ESC_MCU1)"))
	expect(destOf("ESC (U_ESC1)")).toBe(destOf("ESC (U_ESC3)")) // the channels share one page
	expect(destOf("ESC (U_ESC1)")).not.toBe(destOf("Top (Top)"))

	// Net colours are remembered; every export starts physical.
	await page.getByRole("button", { name: "Export PDF" }).click()
	await expect(dialog.getByRole("radio", { name: /^Physical/ })).toBeChecked()
	await expect(dialog.getByRole("checkbox", { name: "Net colours" })).not.toBeChecked()
})
