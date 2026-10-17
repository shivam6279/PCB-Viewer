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

test("a part hidden from the inspector is noted on top and listed in the Objects panel until focus moves on", async ({ page }) => {
	await openCubli3d(page)
	const stats = () => page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.stats())
	const before = (await stats()).shown
	const p = await clientOfComponent(page, "U13_ESC")
	await page.mouse.click(p.x, p.y)
	const inspector = page.locator(".inspector")
	await inspector.getByRole("button", { name: "Hide" }).click()
	await expect(inspector.getByRole("button", { name: "Show" })).toBeVisible()
	expect((await stats()).shown).toBe(before - 1) // that one part, not every channel's U13
	const badge = page.locator(".view3d .pcb-mirror-badge")
	await expect(badge).toHaveText("1 part hidden")
	await shot(page, "3d-part-hidden")

	// The note opens the Objects panel, which lists the part; a click there selects it.
	await page.keyboard.press("Escape")
	await badge.click()
	const panel = page.getByRole("complementary", { name: "Objects", exact: true })
	// Labelled with its channel's designator: the board has three U13_ESC.
	const row = panel.locator('[data-part="U13_ESC_3"]')
	await row.click()
	await expect(inspector).toContainText("U13_ESC")
	await expect(row).toHaveClass(/selected/)
	await shot(page, "3d-hidden-list")

	// Shown again: drawn, the note goes, but the row stays (to hide it back) until a click elsewhere.
	await row.getByRole("button", { name: "Show U13_ESC_3" }).click()
	expect((await stats()).shown).toBe(before)
	await expect(badge).toHaveCount(0)
	await expect(row).toBeVisible()
	await expect(row).not.toHaveClass(/hidden/)
	await shot(page, "3d-shown-lingering")
	const box = (await page.locator(".view3d-canvas").boundingBox())!
	await page.mouse.click(box.x + box.width - 20, box.y + box.height - 20)
	await expect(row).toHaveCount(0)
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

test("F turns the board over about the point under the cursor, eased, and F again turns it back", async ({ page }) => {
	await openCubli3d(page)
	// Panned off the centre and turned a little, so the turn's axis and centre both show.
	const start = await page.evaluate(() => {
		const e = (document.querySelector(".view3d-canvas") as any).__view3d
		const v = e.getView()
		v.offset.set(v.offset.x + 15, v.offset.y - 8)
		e.setView(v)
		e.rotate(40, 25)
		const w = e.getView()
		return { q: w.quaternion.toArray() as [number, number, number, number], offset: [w.offset.x, w.offset.y], distance: w.distance }
	})
	// The cursor off the middle of the view, over the board.
	const box = (await page.locator(".view3d-canvas").boundingBox())!
	const cursor = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.6 }
	await page.mouse.move(cursor.x, cursor.y)
	// The turn's pivot: the board's mid-plane under the cursor.
	const pivot: number[] = await page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.flipPivot().toArray())
	await shot(page, "3d-flip-before")
	const view = () =>
		page.evaluate(() => {
			const v = (document.querySelector(".view3d-canvas") as any).__view3d.getView()
			return { q: v.quaternion.toArray() as [number, number, number, number], offset: [v.offset.x, v.offset.y], distance: v.distance }
		})
	// Sample the turn frame by frame: the camera's facing goes through the in-between angles.
	const angles: number[] = await page.evaluate(
		q0 =>
			new Promise(done => {
				const e = (document.querySelector(".view3d-canvas") as any).__view3d
				const out: number[] = []
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF" }))
				const t0 = performance.now()
				const tick = () => {
					const q = e.getView().quaternion.toArray()
					const dot = Math.abs(q[0] * q0[0] + q[1] * q0[1] + q[2] * q0[2] + q[3] * q0[3])
					out.push((2 * Math.acos(Math.min(dot, 1)) * 180) / Math.PI)
					if (performance.now() - t0 < 600) requestAnimationFrame(tick)
					else done(out)
				}
				requestAnimationFrame(tick)
			}),
		start.q,
	)
	expect(angles.some(a => a > 20 && a < 160)).toBe(true) // eased, not a jump
	expect(angles.at(-1)).toBeCloseTo(180, 1)
	const after = await view()
	// The spot under the cursor stays under it: the pivot projects to the same screen point.
	const pivotOnScreen = await page.evaluate(p => {
		const e = (document.querySelector(".view3d-canvas") as any).__view3d
		e.applyView()
		const v = new e.camera.position.constructor(...p).project(e.camera)
		const r = e.canvas.getBoundingClientRect()
		return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
	}, pivot)
	expect(pivotOnScreen.x).toBeCloseTo(cursor.x, 1)
	expect(pivotOnScreen.y).toBeCloseTo(cursor.y, 1)
	// Half a turn about the screen's vertical laid flat on the board: top and bottom swap (every camera
	// axis's height above the board reverses) and nothing else.
	const turn = await page.evaluate(
		([q0, q1]) => {
			const e = (document.querySelector(".view3d-canvas") as any).__view3d
			const Q = e.camera.quaternion.constructor
			const V = e.camera.position.constructor
			const a = new Q().fromArray(q0), b = new Q().fromArray(q1)
			const axis = new V(0, 1, 0).applyQuaternion(a).setZ(0).normalize()
			const expected = new Q().setFromAxisAngle(axis, Math.PI).multiply(a)
			const z = (q: any, v: number[]) => new V(...v).applyQuaternion(q).z
			return {
				match: Math.abs(expected.dot(b)),
				heights: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(v => z(a, v) + z(b, v)),
			}
		},
		[start.q, after.q],
	)
	expect(turn.match).toBeCloseTo(1, 6)
	for (const h of turn.heights) expect(h).toBeCloseTo(0, 6)
	await shot(page, "3d-flip-after")
	// F again: back where it started.
	await page.keyboard.press("f")
	await expect
		.poll(async () => {
			const q = (await view()).q
			return Math.abs(q[0] * start.q[0] + q[1] * start.q[1] + q[2] * start.q[2] + q[3] * start.q[3])
		})
		.toBeCloseTo(1, 6)
	// From the side: the board turns over in place, the same edge still facing the camera.
	await page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.showFace("front"))
	const axesOf = () =>
		page.evaluate(() => {
			const e = (document.querySelector(".view3d-canvas") as any).__view3d
			const q = e.getView().quaternion
			const V = e.camera.position.constructor
			const r = (v: number[]) => new V(...v).applyQuaternion(q).toArray().map((c: number) => Math.round(c * 1e6) / 1e6 + 0)
			return { back: r([0, 0, 1]), up: r([0, 1, 0]) }
		})
	await expect.poll(async () => (await axesOf()).up).toEqual([0, 0, 1])
	await page.keyboard.press("f")
	await expect.poll(async () => (await axesOf()).up).toEqual([0, 0, -1])
	expect((await axesOf()).back).toEqual([0, -1, 0])
	await shot(page, "3d-flip-side")
})

test("the view cube turns with the board, and a face click turns the view straight to that side", async ({ page }) => {
	await openCubli3d(page)
	const cube = page.getByRole("group", { name: "View cube" })
	// The faces turned towards the viewer (the others show through faintly and take no clicks).
	const shown = () => cube.locator(".view-cube-face").evaluateAll(els => els.filter(e => (e as HTMLElement).dataset.side === "front").map(e => (e as HTMLElement).dataset.face).sort())
	// Opened from the top: only the top face shows.
	expect(await shown()).toEqual(["top"])
	// Turned a little: three faces show, the top among them.
	await page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.rotate(60, 45))
	await expect.poll(async () => (await shown()).length).toBe(3)
	expect(await shown()).toContain("top")
	await shot(page, "3d-view-cube")
	// The camera's axes and where the turn's pivot lands on screen (normalised, middle = 0,0).
	const state = () =>
		page.evaluate(() => {
			const e = (document.querySelector(".view3d-canvas") as any).__view3d
			const q = e.getView().quaternion
			const V = e.camera.position.constructor
			const axis = (x: number, y: number, z: number) => new V(x, y, z).applyQuaternion(q).toArray().map((c: number) => Math.round(c * 1e6) / 1e6)
			return { back: axis(0, 0, 1), up: axis(0, 1, 0), right: axis(1, 0, 0) }
		})
	const pivot = await page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.rotationPivot().toArray())
	const onScreen = (p: number[]) =>
		page.evaluate(p => {
			const e = (document.querySelector(".view3d-canvas") as any).__view3d
			e.render()
			const v = new e.camera.position.constructor(...p).project(e.camera)
			return [v.x, v.y]
		}, p)
	// A mouse turn, drawn at once so the cube shows it.
	const turnBy = (dx: number, dy: number) =>
		page.evaluate(([dx, dy]) => {
			const e = (document.querySelector(".view3d-canvas") as any).__view3d
			e.rotate(dx, dy)
			e.render()
		}, [dx, dy])
	const near = (a: number[], b: number[]) => a.every((c, i) => Math.abs(c - b[i]!) < 1e-4)

	// Each face: the camera's back (towards the viewer) and up axes looking straight at it.
	const faceAxes: Record<string, { back: number[]; up: number[] }> = {
		top: { back: [0, 0, 1], up: [0, 1, 0] },
		bottom: { back: [0, 0, -1], up: [0, 1, 0] },
		front: { back: [0, -1, 0], up: [0, 0, 1] },
		back: { back: [0, 1, 0], up: [0, 0, 1] },
		right: { back: [1, 0, 0], up: [0, 0, 1] },
		left: { back: [-1, 0, 0], up: [0, 0, 1] },
	}
	const clickFace = async (face: string) => {
		await cube.locator(`[data-face="${face}"]`).click()
		await expect.poll(async () => near((await state()).back, faceAxes[face]!.back)).toBe(true)
		expect(near((await state()).up, faceAxes[face]!.up)).toBe(true)
		await expect.poll(shown).toEqual([face])
	}

	// Seen from above the back-left corner: Top, Back and Left show. Back turns the view to the back.
	expect(await shown()).toEqual(["back", "left", "top"])
	await clickFace("back")
	// It turned about the point in the middle of the screen, which stays there.
	const [px, py] = await onScreen(pivot)
	expect(Math.abs(px!)).toBeLessThan(0.01)
	expect(Math.abs(py!)).toBeLessThan(0.01)
	await shot(page, "3d-view-cube-back")
	// Turned about the vertical: a side shows next to the back.
	await turnBy(50, 0)
	const side = (await shown()).find(f => f === "left" || f === "right")!
	expect(side).toBeTruthy()
	await clickFace(side)
	// Tilted: the bottom (or top) shows; the bottom reads mirrored, turned over about the vertical.
	await turnBy(0, -50)
	const lid = (await shown()).find(f => f === "top" || f === "bottom")!
	expect(lid).toBeTruthy()
	await clickFace(lid)
	await shot(page, `3d-view-cube-${lid}`)
	if (lid === "bottom") expect(near((await state()).right, [-1, 0, 0])).toBe(true)
})

test("the view cube drags like the board, and its arrows turn about one view axis: a quarter turn on click, freely on drag", async ({ page }) => {
	await openCubli3d(page)
	const cube = page.getByRole("group", { name: "View cube" })
	const quat = () => page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.getView().quaternion.toArray() as number[])
	// The angle and axis (in the starting view's own axes) of the turn from q0 to now.
	const turnSince = (q0: number[]) =>
		page.evaluate(q0 => {
			const e = (document.querySelector(".view3d-canvas") as any).__view3d
			const Q = e.camera.quaternion.constructor
			const a = new Q().fromArray(q0)
			const b = e.getView().quaternion
			// b = r · a, r in world terms; seen in a's own axes: a⁻¹ · r · a = a⁻¹ · b.
			const local = a.clone().invert().multiply(b)
			if (local.w < 0) local.set(-local.x, -local.y, -local.z, -local.w)
			const angle = (2 * Math.acos(Math.min(local.w, 1)) * 180) / Math.PI
			const sin = Math.sqrt(Math.max(1 - local.w * local.w, 1e-12))
			return { angle, axis: [local.x / sin, local.y / sin, local.z / sin].map(c => Math.round(c * 1000) / 1000 + 0) }
		}, q0)
	const arrows = cube.locator(".view-cube-arrow")
	// The arrows show only while the mouse is over the cube.
	await expect(arrows.first()).toHaveCSS("opacity", "0")
	const box = (await cube.locator(".view-cube-box").boundingBox())!
	const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
	await page.mouse.move(mid.x, mid.y)
	await expect(arrows.first()).toHaveCSS("opacity", "1")
	await shot(page, "3d-cube-arrows")

	// Dragging the cube turns the board, as a drag on the board does, and selects no face.
	let q0 = await quat()
	await page.mouse.down()
	await page.mouse.move(mid.x + 20, mid.y + 10, { steps: 4 })
	await page.mouse.up()
	expect((await turnSince(q0)).angle).toBeGreaterThan(10)
	await expect.poll(async () => (await cube.locator('[data-side="front"]').count()) > 1).toBe(true)
	await shot(page, "3d-cube-dragged")

	// Each arrow clicked: a quarter turn about its own view axis, no other.
	const steps: [string, number[]][] = [
		["Turn right", [0, -1, 0]],
		["Turn left", [0, 1, 0]],
		["Turn up", [1, 0, 0]],
		["Turn down", [-1, 0, 0]],
		["Roll clockwise", [0, 0, 1]],
		["Roll anticlockwise", [0, 0, -1]],
	]
	for (const [name, axis] of steps) {
		q0 = await quat()
		await cube.getByRole("button", { name }).click()
		await expect.poll(async () => (await turnSince(q0)).angle).toBeCloseTo(90, 3)
		expect((await turnSince(q0)).axis).toEqual(axis)
	}
	// Clockwise from the top: the board's up (+y) goes to the screen's right.
	await page.evaluate(() => (document.querySelector(".view3d-canvas") as any).__view3d.showFace("top"))
	await expect.poll(async () => Math.abs((await quat())[3]!)).toBeCloseTo(1, 6)
	await page.mouse.move(mid.x, mid.y)
	await cube.getByRole("button", { name: "Roll clockwise" }).click()
	await expect
		.poll(() =>
			page.evaluate(() => {
				const e = (document.querySelector(".view3d-canvas") as any).__view3d
				const right = new e.camera.position.constructor(1, 0, 0).applyQuaternion(e.getView().quaternion)
				return Math.round(right.y * 1e6) / 1e6
			}),
		)
		.toBe(1)

	// An arrow dragged: a free turn, still about only that axis.
	for (const [name, axis] of [["Turn right", [0, 1, 0]], ["Turn up", [1, 0, 0]]] as const) {
		await page.mouse.move(mid.x, mid.y)
		const arrow = (await cube.getByRole("button", { name }).boundingBox())!
		q0 = await quat()
		await page.mouse.move(arrow.x + arrow.width / 2, arrow.y + arrow.height / 2)
		await page.mouse.down()
		await page.mouse.move(arrow.x + arrow.width / 2 - 15, arrow.y + arrow.height / 2 - 25, { steps: 5 })
		await page.mouse.up()
		const t = await turnSince(q0)
		expect(t.angle).toBeGreaterThan(5)
		expect(t.angle).toBeLessThan(80)
		expect(t.axis).toEqual(axis)
	}
})

test("solder joints are off at first; Solder Joints in the Objects panel builds and shows them", async ({ page }) => {
	await openCubli3d(page)
	const solder = () => page.evaluate(() => { const e = (document.querySelector(".view3d-canvas") as any).__view3d; return { built: e.hasSolder, joints: e.solder.children.length, shown: e.solder.visible } })
	expect(await solder()).toMatchObject({ built: false, joints: 0 })
	const panel = page.getByRole("complementary", { name: "Objects", exact: true })
	await page.locator(".docbar-tool", { hasText: "Objects" }).click()
	await panel.locator('[data-kind="solder"]').hover()
	await panel.getByRole("button", { name: "Show Solder Joints" }).click()
	await expect.poll(async () => (await solder()).joints, { timeout: 30_000 }).toBeGreaterThan(100)
	expect((await solder()).shown).toBe(true)
	await panel.getByRole("button", { name: "Hide Solder Joints" }).click()
	expect((await solder()).shown).toBe(false)
})

test("a bottom-side part's 3D button frames it from below", async ({ page }) => {
	await openCubli3d(page)
	// A bottom-side part, picked with the board turned over.
	const designator: string = await page.evaluate(() => {
		const e = (document.querySelector(".view3d-canvas") as any).__view3d
		const parts = e.scene.components.filter((c: any) => c.side === "bottom" && /^U/.test(c.designator))
		return parts.sort((a: any, b: any) => (b.outline[2] - b.outline[0]) * (b.outline[3] - b.outline[1]) - (a.outline[2] - a.outline[0]) * (a.outline[3] - a.outline[1]))[0].designator
	})
	const panel = page.getByRole("complementary", { name: "Objects", exact: true })
	await page.locator(".docbar-tool", { hasText: "Objects" }).click()
	await panel.getByRole("button", { name: "Bottom", exact: true }).click()
	await page.waitForTimeout(300)
	const at = await clientOfComponent(page, designator)
	await page.mouse.click(at.x, at.y)
	await expect(page.locator(".inspector .inspector-head .title")).toHaveText(designator)
	// The view cube moves out from under the inspector, so it can still be reached.
	const cube = (await page.locator(".view-cube").boundingBox())!
	const inspector = (await page.locator(".inspector").boundingBox())!
	expect(cube.x + cube.width).toBeLessThanOrEqual(inspector.x)
	await expect(page.locator(".view-cube-face[data-side='front']").first()).toBeVisible()
	// Back on the top, then asked to show it in 3D: it is framed from below.
	await panel.getByRole("button", { name: "Top", exact: true }).click()
	await page.locator(".inspector-views").getByRole("button", { name: "3D" }).click()
	const facing = () => page.evaluate(() => { const e = (document.querySelector(".view3d-canvas") as any).__view3d; return new e.camera.position.constructor(0, 0, 1).applyQuaternion(e.getView().quaternion).z })
	await expect.poll(facing).toBeLessThan(-0.99)
	await shot(page, "3d-bottom-part")
})
