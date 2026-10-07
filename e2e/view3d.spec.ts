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
	// The PCB view's own panel (also Top / Bottom / Objects) stays mounted behind: look in this one.
	const toggle = page.locator(".docbar-tool", { hasText: "Objects" })
	const panel = page.getByRole("complementary", { name: "Objects", exact: true })
	await toggle.click()
	await panel.getByRole("button", { name: "Bottom", exact: true }).click()
	await panel.getByRole("button", { name: "Close" }).click()
	await page.waitForTimeout(300)
	await shot(page, "3d-bottom")
	await toggle.click()
	await panel.getByRole("button", { name: "Top", exact: true }).click()
	await panel.locator('[data-kind="body"]').hover()
	await panel.getByRole("button", { name: "Hide 3D Body" }).click()
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

test("Orthographic keeps parallel edges parallel, and zoom and picking still follow the cursor", async ({ page }) => {
	const errors: string[] = []
	page.on("pageerror", e => errors.push(e.message))
	await openCubli3d(page)
	const canvas = (await page.locator(".view3d-canvas").boundingBox())!
	const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2
	// The board's outline corners on screen; in a parallel projection opposite edges stay equal.
	const skew = () =>
		page.evaluate(() => {
			const e = (document.querySelector(".view3d-canvas") as any).__view3d
			const [x0, y0, x1, y1] = e.scene.bounds
			const [a, b, c, d] = [e.toClient(x0, y0), e.toClient(x1, y0), e.toClient(x1, y1), e.toClient(x0, y1)]
			const len = (p: any, q: any) => Math.hypot(p.x - q.x, p.y - q.y)
			return Math.max(Math.abs(len(a, b) - len(d, c)) / len(a, b), Math.abs(len(a, d) - len(b, c)) / len(a, d))
		})
	const turn = async () => {
		await page.mouse.move(cx, cy)
		await page.mouse.down()
		await page.mouse.move(cx + 60, cy - 120, { steps: 10 })
		await page.mouse.up()
		await page.waitForTimeout(200)
	}
	await turn()
	expect(await skew()).toBeGreaterThan(0.02) // perspective: the far edge is shorter
	await shot(page, "3d-perspective")

	const projection = {
		selectOption: (id: "perspective" | "orthographic") => page.getByRole("radio", { name: id === "perspective" ? "Perspective" : "Orthographic" }).click(),
	}
	await projection.selectOption("orthographic")
	await page.waitForTimeout(200)
	expect(await skew()).toBeLessThan(0.001)
	await shot(page, "3d-orthographic")

	// Zooming towards a part keeps the point under the cursor in place: everything else scales about
	// it. (The cursor lands on whole pixels, so the part itself drifts by its sub-pixel offset times
	// the zoom.)
	// (The zoom is the view height.)
	const zoom = () => page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.camera.top)
	const before = await clientOfComponent(page, "U13_ESC")
	const m = { x: Math.round(before.x), y: Math.round(before.y) }
	const h0 = await zoom()
	await page.mouse.move(m.x, m.y)
	for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -300)
	await page.waitForTimeout(200)
	const scale = h0 / (await zoom())
	expect(scale).toBeGreaterThan(2)
	const after = await clientOfComponent(page, "U13_ESC")
	expect(Math.hypot(after.x - m.x - (before.x - m.x) * scale, after.y - m.y - (before.y - m.y) * scale)).toBeLessThan(0.5)
	await shot(page, "3d-orthographic-zoomed")

	// A click picks the part under it, turned and zoomed in.
	await page.mouse.click(after.x, after.y)
	await expect(page.locator(".inspector")).toContainText("U13_ESC")
	await page.keyboard.press("Escape")

	// Zoomed in away from the board centre: panning and turning never change the zoom, and turns are
	// about the board point in the middle of the screen.
	const state = () =>
		page.evaluate(() => {
			const e = (document.querySelector(".view3d-canvas") as any).__view3d
			e.render()
			const p = e.rotationPivot().project(e.camera)
			return { half: e.camera.top, x: p.x, y: p.y, pivot: e.rotationPivot().toArray() }
		})
	const drag = async (button: "left" | "right", dx: number, dy: number) => {
		await page.mouse.move(cx, cy)
		await page.mouse.down({ button })
		await page.mouse.move(cx + dx, cy + dy, { steps: 10 })
		await page.mouse.up({ button })
		await page.waitForTimeout(100)
	}
	const s0 = await state()
	expect(Math.hypot(s0.pivot[0], s0.pivot[1])).toBeGreaterThan(5)
	for (const [button, dx, dy] of [["right", 300, 150], ["left", -150, 80], ["right", -400, -200], ["left", 200, 120], ["right", 250, -100]] as const) {
		await drag(button, dx, dy)
		const s1 = await state()
		expect(Math.abs(s1.half / s0.half - 1)).toBeLessThan(1e-6)
		expect(Math.abs(s1.x)).toBeLessThan(0.01)
		expect(Math.abs(s1.y)).toBeLessThan(0.01)
	}
	await shot(page, "3d-orthographic-turned")

	// Switching projection keeps the point in the middle of the screen and its size there.
	const spot = () => clientOfComponent(page, "U13_ESC")
	const at0 = await spot()
	const pivotPx = async () => {
		const st = await state()
		return { x: canvas.x + ((st.x + 1) / 2) * canvas.width, y: canvas.y + ((1 - st.y) / 2) * canvas.height }
	}
	const c0 = await pivotPx()
	await projection.selectOption("perspective")
	await page.waitForTimeout(200)
	const c1 = await pivotPx()
	expect(Math.hypot(c1.x - c0.x, c1.y - c0.y)).toBeLessThan(0.5)
	await projection.selectOption("orthographic")
	await page.waitForTimeout(200)
	const at2 = await spot()
	expect(Math.hypot(at2.x - at0.x, at2.y - at0.y)).toBeLessThan(0.5)
	expect(Math.abs((await state()).half / s0.half - 1)).toBeLessThan(1e-6)

	// The choice is remembered.
	await page.reload()
	await openCubli3d(page)
	await expect(page.getByRole("radio", { name: "Orthographic" })).toHaveAttribute("aria-checked", "true")
	expect(errors).toEqual([])
})
