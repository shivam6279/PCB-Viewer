import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { hasCorpus } from "../tests/corpus/env"
import { CUBLI_DIR, zipTopLevel } from "./fixtures"

// Set SHOTS_DIR to save screenshots of each interaction for visual review.
const SHOTS_DIR = process.env.SHOTS_DIR
const shot = async (page: Page, name: string) => {
	if (SHOTS_DIR) await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) })
}

test.skip(!hasCorpus, "local corpus not available")
test.use({ viewport: { width: 1600, height: 900 } })

async function openCubli(page: Page) {
	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: "Cubli.zip", mimeType: "application/zip", buffer: zipTopLevel(CUBLI_DIR) })
	await expect(page.locator('.sch-view[data-status="ready"][data-compiled="true"]')).toBeVisible({ timeout: 60_000 })
}

async function openSheet(page: Page, label: string) {
	await page.locator(".sidebar .tree-row", { hasText: label }).first().click()
	const nodeId = await page.getByLabel("Sheet", { exact: true }).inputValue()
	await expect(page.locator(`.sch-view[data-node="${nodeId}"][data-status="ready"][data-compiled="true"]`)).toBeVisible({ timeout: 30_000 })
	return nodeId
}

// Client coordinates of a point on a drawn object: the middle of a wire's first segment, else the
// centre of the element's box.
async function pointOn(page: Page, selector: string, index = 0): Promise<{ x: number; y: number }> {
	return page.evaluate(
		([sel, n]) => {
			const g = document.querySelectorAll(`.sch-view[data-status="ready"] ${sel}`)[n as number] as SVGGElement | undefined
			if (!g) throw new Error(`no element for ${sel}`)
			const svg = g.ownerSVGElement!
			const ctm = svg.getScreenCTM()!
			const line = g.querySelector("polyline")
			let p: DOMPoint
			if (line && line.points.numberOfItems >= 2) {
				const a = line.points.getItem(0)
				const b = line.points.getItem(1)
				p = new DOMPoint((a.x + b.x) / 2, (a.y + b.y) / 2)
			} else {
				const b = g.getBBox()
				p = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2)
			}
			const s = p.matrixTransform(ctm)
			return { x: s.x, y: s.y }
		},
		[selector, index] as const,
	)
}

test("clicking a wire selects its net: highlight on the sheet and the net panel", async ({ page }) => {
	const errors: string[] = []
	page.on("pageerror", e => errors.push(e.message))
	await openCubli(page)
	await openSheet(page, "Power.SchDoc")
	const wire = page.locator('.sch-view g[data-k="27"]').first()
	const i = await wire.getAttribute("data-i")
	const p = await pointOn(page, 'g[data-k="27"]')
	await page.mouse.click(p.x, p.y)
	const panel = page.getByRole("complementary", { name: "Net properties" })
	await expect(panel).toBeVisible()
	await expect(page.locator(`.sch-overlay .sel-net[data-ci="${i}"]`)).toHaveCount(1)
	expect(await page.locator(".sch-overlay .sel-net").count()).toBeGreaterThan(1)
	await expect(page.locator(".sch-overlay .sel-dim")).toHaveCount(1)
	await expect(panel.locator(".inspector-row.current")).toHaveCount(1)
	await shot(page, "net-selected")

	// Clicking empty canvas clears it.
	const box = (await page.locator(".sch-view").boundingBox())!
	await page.mouse.click(box.x + 5, box.y + 5)
	await expect(panel).toHaveCount(0)
	await expect(page.locator(".sch-overlay .sel-dim")).toHaveCount(0)
	expect(errors).toEqual([])
})

test("clicking a component body shows its designator, comment, parameters and board location", async ({ page }) => {
	await openCubli(page)
	await openSheet(page, "Power.SchDoc")
	// A component's body rectangle (record 14) — its centre is inside the part.
	const p = await pointOn(page, 'g[data-k="14"][data-o]')
	await page.mouse.click(p.x, p.y)
	const panel = page.getByRole("complementary", { name: "Component properties" })
	await expect(panel).toBeVisible()
	await expect(panel.locator(".inspector-head .title")).not.toBeEmpty()
	await expect(panel.getByText(/X: -?\d+\.\d{3}mm; Y: -?\d+\.\d{3}mm/)).toBeVisible()
	await expect(page.locator(".sch-overlay .sel-box")).toHaveCount(1)
	// The footprint picture is rendered from the board.
	const picture = panel.locator(".footprint-picture svg")
	await expect(picture).toBeVisible({ timeout: 15_000 })
	// Cropped to the part, not the whole board.
	await expect.poll(async () => Number((await picture.getAttribute("viewBox"))!.split(" ")[2])).toBeLessThan(1500)
	expect(await picture.locator("[data-record=Pad]").count()).toBeGreaterThan(0)
	await shot(page, "component-selected")
})

test("a sheet symbol opens its child sheet", async ({ page }) => {
	await openCubli(page)
	const top = await page.getByLabel("Sheet", { exact: true }).inputValue()
	// The symbol's designator (its middle is often a sheet entry, which opens the port menu instead).
	const p = await pointOn(page, 'g[data-k="32"][data-o]')
	await page.mouse.click(p.x, p.y)
	await expect.poll(() => page.getByLabel("Sheet", { exact: true }).inputValue()).not.toBe(top)
	await expect(page.locator('.sch-view[data-status="ready"]')).toBeVisible()
})

test("a port opens the instance menu at the cursor; picking one jumps, frames and highlights", async ({ page }) => {
	await openCubli(page)
	const from = await openSheet(page, "Power.SchDoc")
	const p = await pointOn(page, 'g[data-k="18"]')
	await page.mouse.click(p.x, p.y)
	const menu = page.getByRole("menu")
	await expect(menu).toBeVisible()
	// At the cursor (shifted left/up only as far as needed to stay inside the view).
	const mbox = (await menu.boundingBox())!
	const vbox = (await page.locator(".sch-view").boundingBox())!
	const fitsRight = p.x + mbox.width < vbox.x + vbox.width - 4
	if (fitsRight) expect(Math.abs(mbox.x - p.x)).toBeLessThan(2)
	else expect(mbox.x + mbox.width).toBeGreaterThan(vbox.x + vbox.width - 10)
	await expect(menu.locator(".port-menu-row.current")).toHaveCount(1)
	await shot(page, "port-menu")

	const target = menu.locator(".port-menu-row:not(.current):not(.inert)").first()
	await expect(target).toBeVisible()
	await target.click()
	await expect(menu).toHaveCount(0)
	await expect.poll(() => page.getByLabel("Sheet", { exact: true }).inputValue()).not.toBe(from)
	const view = page.locator('.sch-view[data-status="ready"]')
	await expect(view).toBeVisible()
	await expect.poll(() => page.locator(".sch-overlay .sel-net").count()).toBeGreaterThan(0)
	// Zoomed in on the port rather than showing the whole sheet.
	const vb = (await view.locator("svg").getAttribute("viewBox"))!.split(" ").map(Number)
	const full = await view.locator("svg").evaluate(svg => (svg.querySelector("#altium-sheet-paper rect") as SVGRectElement).width.baseVal.value)
	expect(vb[2]!).toBeLessThan(full * 0.6)
	await shot(page, "port-jumped")
})

test("the Nets tree selects a net; its connectivity rows jump between channel sheets", async ({ page }) => {
	await openCubli(page)
	await page.getByRole("button", { name: "Expand Nets" }).click()
	await page.locator(".sidebar .tree-row", { hasText: /^3V3_MCU_ESC_1$/ }).click()
	const panel = page.getByRole("complementary", { name: "Net properties" })
	await expect(panel.locator(".inspector-head .title")).toHaveText("3V3_MCU_ESC_1")
	await expect(panel.locator("dl")).toContainText("Physical Name3V3_MCU_ESC_1")
	await expect(panel.locator("dl")).toContainText("Net Name3V3_MCU_ESC")
	const rows = panel.locator(".inspector-section", { hasText: "Connectivity" }).locator(".inspector-row")
	await expect(rows).toContainText(["ESC(U_ESC1)", "ESC_MCU(U_ESC_MCU1)"])
	await expect(rows.filter({ hasText: "U_ESC2" })).toHaveCount(0) // only its own channel

	await rows.filter({ hasText: "ESC_MCU(U_ESC_MCU1)" }).click()
	await expect.poll(() => page.getByLabel("Sheet", { exact: true }).inputValue()).toContain("U_ESC_MCU")
	await expect(page.locator('.sch-view[data-status="ready"]')).toBeVisible()
	await expect.poll(() => page.locator(".sch-overlay .sel-net").count()).toBeGreaterThan(0)
	await expect(page.getByLabel("Sheet", { exact: true }).locator("option:checked")).toHaveText("ESC_MCU (U_ESC_MCU1)")
	await expect(rows.filter({ hasText: "ESC_MCU(U_ESC_MCU1)" })).toHaveClass(/current/)
	await shot(page, "connectivity-jump")
})

test("a project net colour reaches the net under its other names on lower sheets", async ({ page }) => {
	// 12V is coloured in the project; in Half_Bridges the same net is called V_GATE_DRIVE.
	await openCubli(page)
	await openSheet(page, "Half_Bridges.SchDoc")
	await expect.poll(() => page.locator('.sch-view [data-net-color][stroke="#fd8300"]').count()).toBeGreaterThan(0)
	await shot(page, "net-colors-half-bridges")
})
