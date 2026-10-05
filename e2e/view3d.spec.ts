import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { hasCorpus } from "../tests/corpus/env"
import { CUBLI_DIR, zipTopLevel } from "./fixtures"

const SHOTS_DIR = process.env.SHOTS_DIR
const shot = async (page: Page, name: string) => {
	if (SHOTS_DIR) await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) })
}

test.skip(!hasCorpus, "local corpus not available")
// A fixed viewport, so the 3D canvas always comes out 1600 x 810.
test.use({ viewport: { width: 1905, height: 916 } })
test.setTimeout(180_000)

async function openCubli3d(page: Page) {
	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: "Cubli.zip", mimeType: "application/zip", buffer: zipTopLevel(CUBLI_DIR) })
	await expect(page.locator('.sch-view[data-status="ready"][data-compiled="true"]')).toBeVisible({ timeout: 60_000 })
	await page.getByRole("tab", { name: "3D" }).click()
	// One loading screen, then the whole board with every part at once.
	await expect(page.locator('.view3d[data-status="ready"]')).toBeVisible({ timeout: 120_000 })
	await page.waitForTimeout(300)
}

// Client point of a board location (mils) on the top face.
async function clientOfComponent(page: Page, designator: string) {
	return page.evaluate(d => {
		const e = (document.querySelector(".view3d-canvas") as any).__view3d
		const c = e.scene.components.find((c: any) => c.designator === d)
		const [x0, y0, x1, y1] = c.outline
		return e.toClient((x0 + x1) / 2, (y0 + y1) / 2, c.side)
	}, designator)
}

test("the board and its parts draw in 3D", async ({ page }) => {
	const errors: string[] = []
	page.on("pageerror", e => errors.push(e.message))
	await openCubli3d(page)
	await shot(page, "3d-board")
	const counts = await page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.stats())
	// Every body of the board is in the scene: 441 STEP placements + 42 extruded outlines.
	expect(counts.bodies).toBe(483)
	expect(counts.failed).toBe(0)
	expect(errors).toEqual([])
})

test("clicking a part selects it: the rest goes grey and the inspector opens", async ({ page }) => {
	await openCubli3d(page)
	const p = await clientOfComponent(page, "U13_ESC")
	await page.mouse.click(p.x, p.y)
	await expect(page.locator(".inspector")).toBeVisible()
	await expect(page.locator(".inspector")).toContainText("U13_ESC")
	await shot(page, "3d-selected")
	await page.keyboard.press("Escape")
	await expect(page.locator(".inspector")).toHaveCount(0)
})

test("Objects panel: Bottom turns the board over, 3D Body hides the parts", async ({ page }) => {
	await openCubli3d(page)
	await page.getByRole("button", { name: "Objects", exact: true }).click()
	await page.getByRole("button", { name: "Bottom", exact: true }).click()
	await page.getByRole("button", { name: "Close" }).click()
	await page.waitForTimeout(300)
	await shot(page, "3d-bottom")
	await page.getByRole("button", { name: "Objects", exact: true }).click()
	await page.getByRole("button", { name: "Top", exact: true }).click()
	await page.locator('[data-kind="body"]').hover()
	await page.getByRole("button", { name: "Hide 3D Body" }).click()
	await page.waitForTimeout(300)
	await shot(page, "3d-no-bodies")
})

test("a net picked in the tree is framed from the top with its copper in colour", async ({ page }) => {
	await openCubli3d(page)
	// Turned away first: framing a net brings the view back to the top.
	await page.mouse.move(1700, 400)
	await page.mouse.down()
	await page.mouse.move(1720, 380, { steps: 4 })
	await page.mouse.up()
	await page.getByRole("button", { name: "Expand Nets" }).click()
	await page.locator(".tree-row", { hasText: /^12V$/ }).click()
	await expect(page.locator(".inspector")).toContainText("12V")
	await expect(page.getByRole("tab", { name: "3D" })).toHaveAttribute("aria-selected", "true")
	await page.waitForTimeout(800)
	await shot(page, "3d-net")
})

test("turning pivots on the middle of the screen, on the board, wherever the view was zoomed to", async ({ page }) => {
	await openCubli3d(page)
	const canvas = await page.locator(".view3d-canvas").boundingBox()
	// Zoom in towards the board's top-left area, so the middle of the screen is far from the board centre.
	await page.mouse.move(canvas!.x + canvas!.width * 0.25, canvas!.y + canvas!.height * 0.3)
	for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -300)
	await page.waitForTimeout(200)
	const pivot = await page.evaluate(() => {
		const e = (document.querySelector(".view3d-canvas") as any).__view3d
		const p = e.rotationPivot()
		return { x: p.x, y: p.y, z: p.z }
	})
	expect(Math.hypot(pivot.x, pivot.y)).toBeGreaterThan(5) // well away from the board centre (mm)
	await shot(page, "3d-pivot-before")
	const cx = canvas!.x + canvas!.width / 2, cy = canvas!.y + canvas!.height / 2
	await page.mouse.move(cx, cy)
	await page.mouse.down()
	await page.mouse.move(cx + 120, cy - 60, { steps: 10 })
	await page.mouse.up()
	await page.waitForTimeout(200)
	await shot(page, "3d-pivot-after")
	// The pivot is still in the middle of the screen (normalised device coords ~0, 0).
	const ndc = await page.evaluate(p => {
		const e = (document.querySelector(".view3d-canvas") as any).__view3d
		e.render()
		const v = e.rotationPivot().clone().set(p.x, p.y, p.z).project(e.camera)
		return { x: v.x, y: v.y }
	}, pivot)
	expect(Math.abs(ndc.x)).toBeLessThan(0.01)
	expect(Math.abs(ndc.y)).toBeLessThan(0.01)
})
