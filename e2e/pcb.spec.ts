import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { CORPUS, hasCorpus } from "../tests/corpus/env"
import { CUBLI_DIR, zipTopLevel } from "./fixtures"

const SHOTS_DIR = process.env.SHOTS_DIR
const shot = async (page: Page, name: string) => {
	if (SHOTS_DIR) await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) })
}

test.skip(!hasCorpus, "local corpus not available")
test.use({ viewport: { width: 1600, height: 900 } })

async function openCubliPcb(page: Page) {
	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: "Cubli.zip", mimeType: "application/zip", buffer: zipTopLevel(CUBLI_DIR) })
	await expect(page.locator('.sch-view[data-status="ready"][data-compiled="true"]')).toBeVisible({ timeout: 60_000 })
	await page.getByRole("tab", { name: "PCB" }).click()
	await expect(page.locator('.pcb-view[data-status="ready"]')).toBeVisible({ timeout: 60_000 })
}

test("the board draws", async ({ page }) => {
	const errors: string[] = []
	page.on("pageerror", e => errors.push(e.message))
	await openCubliPcb(page)
	await page.waitForTimeout(300)
	await shot(page, "pcb-board")
	expect(errors).toEqual([])
})

type Pcb = { scene: any; toClient(x: number, y: number): { x: number; y: number }; camera(): { scale: number; flip: boolean } }

// Client point of a board object, found in the page's scene by a predicate (source text, run in page).
async function clientOf(page: Page, find: string): Promise<{ x: number; y: number }> {
	return page.evaluate(src => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb as Pcb
		const s = pcb.scene
		const o = new Function("s", `return (${src})`)(s)
		if (!o) throw new Error(`nothing matches ${src}`)
		const p = o.prims[0]
		// A track is clicked in its middle; its ends touch other objects.
		if (o.kind === "track" && p.t === "seg") return pcb.toClient((p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2)
		return pcb.toClient(o.at[0], o.at[1])
	}, find)
}

async function zoomTo(page: Page, find: string, ticks = 8) {
	const p = await clientOf(page, find)
	await page.mouse.move(p.x, p.y)
	for (let k = 0; k < ticks; k++) await page.mouse.wheel(0, -240)
	await page.waitForTimeout(100)
}

// PCB designators repeat per channel (J1_ESC on every ESC); the net tells channel 2's apart.
const PAD = `s.objects.find(o => o.kind === "pad" && o.pad.name === "2" && o.net === "OUT_V_2" && /^J1/.test(s.components[o.component]?.designator))`

test("clicking a pad shows the pad panel; its net link selects and frames the net", async ({ page }) => {
	await openCubliPcb(page)
	await zoomTo(page, PAD)
	const p = await clientOf(page, PAD)
	await page.mouse.click(p.x, p.y)
	const panel = page.getByRole("complementary", { name: "Pad properties" })
	await expect(panel.locator(".inspector-head .title")).toHaveText("J1_ESC_2-2")
	await expect(panel).toContainText("OUT_V_2")
	await expect(panel).toContainText("Plated")
	await expect(panel).toContainText("X: 28.200mm; Y: 13.600mm")
	await expect(panel).toContainText("Rotation: 180")
	await expect(panel).toContainText("2.500mm; 2.500mm")
	await shot(page, "pcb-pad")

	await panel.getByRole("button", { name: "OUT_V_2" }).click()
	const net = page.getByRole("complementary", { name: "Net properties" })
	await expect(net.locator(".inspector-head .title")).toHaveText("OUT_V_2")
	// The panel shows the compiled net name (OUT_V) rather than the label on the pad's own sheet (SH_V),
	// which is what the board was synchronised from (OUT_V_2). Known difference, see research notes.
	await expect(net.locator("dl")).toContainText("Physical NameOUT_V_2")
	await expect(net.locator(".inspector-section", { hasText: "Layers Used" })).toContainText("Top Layer")
	await shot(page, "pcb-net")
})

test("clicking a track shows its width, layer and length", async ({ page }) => {
	await openCubliPcb(page)
	const TRACK = `s.objects.filter(o => o.kind === "track" && o.net && o.layer === "TOP" && (p => { const h = (document.querySelector(".pcb-canvas")).__pcb.pick((p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2); return h && h.kind === "object" && h.id === o.id })(o.prims[0])).sort((a, b) => b.length - a.length)[0]`
	await zoomTo(page, TRACK, 4)
	const p = await clientOf(page, TRACK)
	await page.mouse.click(p.x, p.y)
	const panel = page.getByRole("complementary", { name: "Track properties" })
	const net = await page.evaluate(src => new Function("s", `return (${src}).net`)((document.querySelector(".pcb-canvas") as any).__pcb.scene), TRACK)
	await expect(panel.locator(".inspector-head .title")).toHaveText(net)
	await expect(panel).toContainText("Top Layer")
	await expect(panel).toContainText(/Width\s*\d+\.\d{3}mm/)
	await shot(page, "pcb-track")
})

test("a component selected on the schematic opens on the board with PCB, framed and highlighted", async ({ page }) => {
	await openCubliPcb(page)
	const fit = await page.evaluate(() => ((document.querySelector(".pcb-canvas") as any).__pcb as Pcb).camera().scale)
	await page.getByRole("tab", { name: "SCH" }).click()
	await expect(page.locator('.sch-view[data-status="ready"]')).toBeVisible()
	const body = await page.evaluate(() => {
		const g = document.querySelector('.sch-view[data-status="ready"] g[data-k="14"][data-o]') as SVGGElement
		const b = g.getBBox()
		const s = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(g.ownerSVGElement!.getScreenCTM()!)
		return { x: s.x, y: s.y }
	})
	await page.mouse.click(body.x, body.y)
	const panel = page.getByRole("complementary", { name: "Component properties" })
	await expect(panel).toBeVisible()
	const designator = (await panel.locator(".inspector-head .title").textContent())!
	await panel.getByRole("button", { name: "PCB" }).click()
	await expect(page.locator('.pcb-view[data-status="ready"]')).toBeVisible()
	await expect(page.getByRole("tab", { name: "PCB" })).toHaveAttribute("aria-selected", "true")
	await expect(panel.locator(".inspector-head .title")).toContainText(designator)
	await expect.poll(() => page.evaluate(() => ((document.querySelector(".pcb-canvas") as any).__pcb as Pcb).camera().scale)).toBeGreaterThan(fit * 3)
	await shot(page, "pcb-component-crossprobe")

	// And back: SCH shows it on its sheet.
	await panel.getByRole("button", { name: "SCH" }).click()
	await expect(page.getByRole("tab", { name: "SCH" })).toHaveAttribute("aria-selected", "true")
	await expect(page.locator(".sch-overlay .sel-box")).toHaveCount(1)
})

test("the layer legend: current layer, modes, eyes, mirror; and their keys", async ({ page }) => {
	await openCubliPcb(page)
	const legend = page.getByRole("region", { name: "Layers" })
	const state = () => page.evaluate(() => ((document.querySelector(".pcb-canvas") as any).__pcb as Pcb & { layers(): any }).layers())
	await expect(legend.getByRole("group", { name: "Copper" }).locator(".pcb-legend-row")).toContainText(["Top Layer", "GND 1", "Signal 1", "PWR 1", "GND 2", "Signal 2", "PWR 2", "Bottom Layer"])
	await expect(legend.locator(".pcb-legend-row.current")).toHaveText("Top Layer")
	await shot(page, "pcb-legend")

	// A click makes a layer current; +/- and Ctrl+Shift+wheel step through the visible layers.
	await legend.locator('.pcb-legend-row[data-layer="MID-LAYER3"]').click()
	await expect(legend.locator(".pcb-legend-row.current")).toHaveText("GND 1")
	await page.mouse.move(1000, 500)
	await page.keyboard.press("+")
	await expect(legend.locator(".pcb-legend-row.current")).toHaveText("Signal 1")
	await page.keyboard.down("Control")
	await page.keyboard.down("Shift")
	await page.mouse.wheel(0, 100)
	await page.waitForTimeout(100)
	await page.mouse.wheel(0, -100)
	await page.waitForTimeout(100)
	await page.mouse.wheel(0, -100)
	await page.keyboard.up("Shift")
	await page.keyboard.up("Control")
	// Wheel down steps back up the list, wheel up down it: Signal 1 -> GND 1 -> Signal 1 -> PWR 1.
	await expect(legend.locator(".pcb-legend-row.current")).toHaveText("PWR 1")
	const zoomBefore = await page.evaluate(() => (document.querySelector(".pcb-canvas") as any).__pcb.camera().scale)

	// Shift+S: all -> highlight -> only -> all.
	await page.keyboard.press("Shift+S")
	await expect(legend.getByRole("button", { name: /Layer mode/ })).toHaveText("Highlight current")
	await page.waitForTimeout(300)
	await shot(page, "pcb-highlight-gnd1")
	await page.keyboard.press("Shift+S")
	await expect(legend.getByRole("button", { name: /Layer mode/ })).toHaveText("Current only")
	expect((await state()).mode).toBe("only")
	await page.waitForTimeout(300)
	await shot(page, "pcb-only-gnd1")
	await page.keyboard.press("Shift+S")
	expect((await state()).mode).toBe("all")
	// The Ctrl+Shift wheel did not zoom.
	expect(await page.evaluate(() => (document.querySelector(".pcb-canvas") as any).__pcb.camera().scale)).toBe(zoomBefore)

	// The eye hides a layer.
	const top = legend.locator('.pcb-legend-row[data-layer="TOP"]')
	await top.getByRole("button", { name: "Hide Top Layer" }).click()
	await expect(top).toHaveClass(/off/)
	expect(await page.evaluate(() => (document.querySelector(".pcb-canvas") as any).__pcb.layers().visible.has("TOP"))).toBe(false)
	await top.getByRole("button", { name: "Show Top Layer" }).click()

	// F mirrors about the board's own centre: the board stays where it is on screen, with a note on it.
	// The panel's Flip button, the legend's and the note all turn it back.
	const flipped = () => page.evaluate(() => ((document.querySelector(".pcb-canvas") as any).__pcb as Pcb).camera().flip)
	const boardCentre = () =>
		page.evaluate(() => {
			const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
			const [x0, y0, x1, y1] = pcb.scene.bounds
			return pcb.toClient((x0 + x1) / 2, (y0 + y1) / 2)
		})
	// Board off to one side first.
	await page.evaluate(() => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const c = pcb.camera()
		pcb.view(c.cx + 400 / c.scale, c.cy, c.scale)
	})
	const before = await boardCentre()
	await page.keyboard.press("f")
	await expect.poll(flipped).toBe(true)
	const after = await boardCentre()
	expect(Math.abs(after.x - before.x)).toBeLessThan(1)
	expect(Math.abs(after.y - before.y)).toBeLessThan(1)
	await expect(page.locator(".pcb-mirror-badge")).toBeVisible()
	await expect(legend.getByRole("button", { name: "Flip" })).toHaveAttribute("aria-pressed", "true")
	await shot(page, "pcb-mirrored")
	await page.getByRole("button", { name: "Layers/Objects" }).click() // the panel starts closed
	const panel = page.getByRole("complementary", { name: "Layers and objects" })
	await expect(panel.getByRole("button", { name: "Flip" })).toHaveAttribute("aria-pressed", "true")
	await panel.getByRole("button", { name: "Flip" }).click()
	await expect(page.locator(".pcb-mirror-badge")).toHaveCount(0)
	await legend.getByRole("button", { name: "Flip" }).click()
	await page.locator(".pcb-mirror-badge").click()
	await expect.poll(flipped).toBe(false)

	// 1-4 switch views from anywhere.
	await page.keyboard.press("4")
	await expect(page.getByRole("tab", { name: "BOM" })).toHaveAttribute("aria-selected", "true")
	await page.keyboard.press("1")
	await expect(page.getByRole("tab", { name: "SCH" })).toHaveAttribute("aria-selected", "true")
	await page.keyboard.press("2")
	await expect(page.getByRole("tab", { name: "PCB" })).toHaveAttribute("aria-selected", "true")
})

test("right-click on the board opens no menu", async ({ page }) => {
	await openCubliPcb(page)
	const prevented = await page.evaluate(() => {
		const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 900, clientY: 500 })
		document.querySelector(".pcb-canvas")!.dispatchEvent(e)
		return e.defaultPrevented
	})
	expect(prevented).toBe(true)
})

const camera = (page: Page) => page.evaluate(() => ((document.querySelector(".pcb-canvas") as any).__pcb as Pcb).camera())

// Client point inside a component's outline but off its pads (or its centre).
async function partPoint(page: Page, find: string) {
	return page.evaluate(src => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const s = pcb.scene
		const i = new Function("s", `return (${src})`)(s) as number
		const c = s.components[i]
		const [x0, y0, x1, y1] = c.outline
		return { index: i, ...pcb.toClient((x0 + x1) / 2, (y0 + y1) / 2) }
	}, find)
}
const TOP_PART = `s.components.findIndex(c => c.side === "top" && c.designator.startsWith("C") && (c.outline[2] - c.outline[0]) > 40)`
const BOTTOM_PART = `s.components.findIndex(c => c.side === "bottom" && c.designator.startsWith("C") && (c.outline[2] - c.outline[0]) > 40)`

test("hovering inside a part outlines it; clicking anywhere in it selects it; the panel overlays the board", async ({ page }) => {
	await openCubliPcb(page)
	const p = await partPoint(page, TOP_PART)
	await page.evaluate(([cx, cy]) => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const c = pcb.scene.components.find((_: any, k: number) => k === cy)
		pcb.view((c.outline[0] + c.outline[2]) / 2, (c.outline[1] + c.outline[3]) / 2, pcb.camera().scale * cx)
	}, [8, p.index])
	const q = await partPoint(page, TOP_PART)
	await page.mouse.move(q.x - 3, q.y - 3)
	await page.mouse.move(q.x, q.y)
	await expect.poll(() => page.evaluate(() => (document.querySelector(".pcb-canvas") as any).__pcb.hover())).toBe(p.index)
	expect(await page.locator(".pcb-view").evaluate(el => getComputedStyle(el).cursor)).toBe("default")
	await shot(page, "pcb-hover")

	const before = await camera(page)
	const width = await page.locator(".pcb-canvas").evaluate(el => (el as HTMLCanvasElement).clientWidth)
	await page.mouse.click(q.x, q.y)
	await expect(page.getByRole("complementary", { name: "Component properties" })).toBeVisible()
	await page.waitForTimeout(200)
	expect(await camera(page)).toEqual(before) // opening the panel does not move the board
	expect(await page.locator(".pcb-canvas").evaluate(el => (el as HTMLCanvasElement).clientWidth)).toBe(width)
	await shot(page, "pcb-part-selected")
})

test("on Top only, bottom-side parts cannot be picked", async ({ page }) => {
	await openCubliPcb(page)
	await page.mouse.move(1000, 500)
	await page.keyboard.press("Shift+S")
	await page.keyboard.press("Shift+S") // current only (Top is current)
	const p = await partPoint(page, BOTTOM_PART)
	await page.evaluate(i => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const c = pcb.scene.components[i]
		pcb.view((c.outline[0] + c.outline[2]) / 2, (c.outline[1] + c.outline[3]) / 2, pcb.camera().scale * 8)
	}, p.index)
	const q = await partPoint(page, BOTTOM_PART)
	const designator = await page.evaluate(i => (document.querySelector(".pcb-canvas") as any).__pcb.scene.components[i].designator, p.index)
	await page.mouse.move(q.x, q.y)
	await page.mouse.click(q.x, q.y)
	await page.waitForTimeout(200)
	// (A Top part over the same spot may be picked instead; the bottom one never is.)
	await expect(page.getByRole("complementary", { name: "Component properties" }).getByText(designator, { exact: true })).toHaveCount(0)
	expect(await page.evaluate(() => (document.querySelector(".pcb-canvas") as any).__pcb.hover())).not.toBe(p.index)
})

test("double-clicking a track selects its whole net", async ({ page }) => {
	await openCubliPcb(page)
	const TRACK = `s.objects.filter(o => o.kind === "track" && o.net && o.layer === "TOP" && (p => { const h = (document.querySelector(".pcb-canvas")).__pcb.pick((p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2); return h && h.kind === "object" && h.id === o.id })(o.prims[0])).sort((a, b) => b.length - a.length)[0]`
	// Framed in the middle of the view: the panel the first click opens must not cover the second.
	const { p, net } = await page.evaluate(src => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const o = new Function("s", `return (${src})`)(pcb.scene)
		const x = (o.prims[0].x1 + o.prims[0].x2) / 2, y = (o.prims[0].y1 + o.prims[0].y2) / 2
		pcb.view(x, y, pcb.camera().scale * 4)
		return { p: pcb.toClient(x, y), net: o.net as string }
	}, TRACK)
	await page.waitForTimeout(100)
	await page.mouse.dblclick(p.x, p.y)
	const panel = page.getByRole("complementary", { name: "Net properties" })
	await expect(panel).toBeVisible()
	await expect(panel.locator(".inspector-head .title")).toHaveText(net)
	await shot(page, "pcb-dblclick-net")
})

test("leaving the PCB tab and coming back keeps the view and layers", async ({ page }) => {
	await openCubliPcb(page)
	await page.getByRole("button", { name: "Layers/Objects" }).click() // the panel starts closed
	await page.getByRole("radio", { name: "Current only" }).click() // Top is current
	const box = (await page.locator(".pcb-view").boundingBox())!
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	for (let k = 0; k < 5; k++) await page.mouse.wheel(0, -240)
	await page.waitForTimeout(300)
	const before = await camera(page)
	await page.getByRole("tab", { name: "SCH" }).click()
	await expect(page.locator('.sch-view[data-status="ready"]')).toBeVisible()
	await page.getByRole("tab", { name: "PCB" }).click()
	await expect(page.locator('.pcb-view[data-status="ready"]')).toBeVisible()
	await page.waitForTimeout(200)
	expect(await camera(page)).toEqual(before)
	await expect(page.getByRole("region", { name: "Layers" }).getByRole("button", { name: /Layer mode/ })).toHaveText("Current only")
})

test("Stackup shows the board's layer stack as a cross-section with its layer table", async ({ page }) => {
	await openCubliPcb(page)
	await page.getByRole("button", { name: "Stackup" }).click()
	const dialog = page.getByRole("dialog", { name: "Layer stack" })
	await expect(dialog).toBeVisible()
	// Top Paste .. Bottom Paste: 21 layers, 8 of them copper.
	await expect(dialog.locator("tbody tr")).toHaveCount(21)
	await expect(dialog.locator(".stackup-summary")).toContainText("8 copper layers")
	await expect(dialog.locator('tr[data-kind="core"]')).toContainText("FR-4")
	await shot(page, "pcb-stackup")
	await dialog.getByRole("radio", { name: "mm" }).click()
	await expect(dialog.locator(".stackup-summary b")).toHaveText(/ mm$/)
	await page.keyboard.press("Escape")
	await expect(dialog).toHaveCount(0)
})

test("the legend sits top left; it moves by its head, resizes by its right and bottom edges, folds to its corner", async ({ page }) => {
	await openCubliPcb(page)
	const legend = page.getByRole("region", { name: "Layers" })
	const view = (await page.locator(".pcb-view").boundingBox())!
	const b0 = (await legend.boundingBox())!
	expect(b0.x - view.x).toBeLessThan(20)
	expect(b0.y - view.y).toBeLessThan(20)

	const head = legend.locator(".pcb-legend-head")
	const hb = (await head.boundingBox())!
	await page.mouse.move(hb.x + hb.width - 40, hb.y + hb.height / 2)
	await page.mouse.down()
	await page.mouse.move(hb.x + hb.width - 40 + 200, hb.y + hb.height / 2 + 80, { steps: 5 })
	await page.mouse.up()
	const b1 = (await legend.boundingBox())!
	expect(Math.round(b1.x - b0.x)).toBe(200)
	expect(Math.round(b1.y - b0.y)).toBe(80)

	const corner = (await legend.locator(".pcb-legend-resize.corner").boundingBox())!
	await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2)
	await page.mouse.down()
	await page.mouse.move(corner.x + corner.width / 2 + 60, corner.y + corner.height / 2 - 150, { steps: 5 })
	await page.mouse.up()
	const b2 = (await legend.boundingBox())!
	expect(Math.round(b2.width - b1.width)).toBe(60)
	expect(Math.round(b2.height - b1.height)).toBe(-150)
	expect([Math.round(b2.x), Math.round(b2.y)]).toEqual([Math.round(b1.x), Math.round(b1.y)])
	await shot(page, "pcb-legend-moved")

	// Folding keeps its top left corner; the placement survives a reload.
	await legend.getByRole("button", { name: "Collapse layers" }).click()
	const b3 = (await legend.boundingBox())!
	expect([Math.round(b3.x), Math.round(b3.y)]).toEqual([Math.round(b1.x), Math.round(b1.y)])
	expect(b3.height).toBeLessThan(50)
	await legend.getByRole("button", { name: "Expand layers" }).click()
	await page.reload()
	await openCubliPcb(page)
	const b4 = (await page.getByRole("region", { name: "Layers" }).boundingBox())!
	expect([Math.round(b4.x), Math.round(b4.y), Math.round(b4.width), Math.round(b4.height)]).toEqual([Math.round(b2.x), Math.round(b2.y), Math.round(b2.width), Math.round(b2.height)])

	// Double-clicking its head glides it back to where it started, at its starting size.
	const moved = page.getByRole("region", { name: "Layers" })
	const head2 = (await moved.locator(".pcb-legend-head .grow").boundingBox())!
	await page.mouse.dblclick(head2.x + head2.width / 2, head2.y + head2.height / 2)
	expect(await moved.evaluate(el => el.getAnimations().length)).toBe(1)
	await expect.poll(() => moved.evaluate(el => el.getAnimations().length)).toBe(0)
	const b5 = (await moved.boundingBox())!
	expect([Math.round(b5.x), Math.round(b5.y), Math.round(b5.width), Math.round(b5.height)]).toEqual([Math.round(b0.x), Math.round(b0.y), Math.round(b0.width), Math.round(b0.height)])
})

test("a turned part's box turns with it (measured as placed at 0°)", async ({ page }) => {
	await page.goto("/")
	const dir = join(CORPUS, "Quad/Rev5/Rev5.3/FlightController")
	await page.getByTestId("zip-input").setInputFiles({ name: "FC.zip", mimeType: "application/zip", buffer: zipTopLevel(dir, "FC") })
	await expect(page.locator('.sch-view[data-status="ready"][data-compiled="true"]')).toBeVisible({ timeout: 60_000 })
	await page.getByRole("tab", { name: "PCB" }).click()
	await expect(page.locator('.pcb-view[data-status="ready"]')).toBeVisible({ timeout: 60_000 })
	// U1 sits at 315°: its box edges run at 45° to the screen, and the box hugs the part (its area well
	// under the axis-aligned extent's).
	const u1 = await page.evaluate(() => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const i = pcb.scene.components.findIndex((c: any) => c.designator === "U1")
		const c = pcb.scene.components[i]
		const [x0, y0, x1, y1] = c.outline
		// The part's extent filling about 40% of the view's height.
		pcb.view(c.x, c.y, ((document.querySelector(".pcb-canvas") as HTMLCanvasElement).height * 0.4) / (y1 - y0))
		const b = c.box
		const angle = (Math.atan2(b[3] - b[1], b[2] - b[0]) * 180) / Math.PI
		const area = Math.hypot(b[2] - b[0], b[3] - b[1]) * Math.hypot(b[4] - b[2], b[5] - b[3])
		// Near a corner of the turned box (inside it); and a corner of the axis-aligned extent (outside it).
		const mx = (b[0] + b[2] + b[4] + b[6]) / 4, my = (b[1] + b[3] + b[5] + b[7]) / 4
		const nearCorner = pcb.toClient(mx + (b[0] - mx) * 0.85, my + (b[1] - my) * 0.85)
		const extentCorner = pcb.toClient(x0 + (x1 - x0) * 0.04, y0 + (y1 - y0) * 0.04)
		return { index: i, rotation: c.rotation, angle, area, extent: (x1 - x0) * (y1 - y0), nearCorner, extentCorner }
	})
	expect(u1.rotation).toBe(315)
	expect(Math.abs((((u1.angle % 90) + 90) % 90) - 45)).toBeLessThan(0.01)
	expect(u1.area).toBeLessThan(u1.extent * 0.7)
	await page.waitForTimeout(300)
	const hovered = () => page.evaluate(() => (document.querySelector(".pcb-canvas") as any).__pcb.hover())
	await page.mouse.move(u1.extentCorner.x, u1.extentCorner.y)
	await expect.poll(hovered).not.toBe(u1.index)
	await page.mouse.move(u1.nearCorner.x, u1.nearCorner.y)
	await expect.poll(hovered).toBe(u1.index)
	await page.waitForTimeout(200)
	await shot(page, "pcb-rotated-box")
})

test("a part's box stands a little off its copper and 3D body; silkscreen and courtyard are left out", async ({ page }) => {
	await openCubliPcb(page)
	const size = (d: string) =>
		page.evaluate(d => {
			const b = (document.querySelector(".pcb-canvas") as any).__pcb.scene.components.find((c: any) => c.designator === d).box
			return [Math.round(Math.hypot(b[2] - b[0], b[3] - b[1])), Math.round(Math.hypot(b[4] - b[2], b[5] - b[3]))]
		}, d)
	// Each stands 10 mil off its copper and body.
	// C37 (100 µF can): pad to pad across, the body's depth (352 x 268). Its courtyard is 394 x 310.
	expect(await size("C37")).toEqual([372, 288])
	// J1_ESC (MR30): its body (472 x 197). Courtyard 482 x 206.
	expect(await size("J1_ESC")).toEqual([492, 217])
	// D4_ESC (0402, no body): its two pads (43 x 28), not the silkscreen 18 mil around them.
	expect(await size("D4_ESC")).toEqual([63, 48])
})

test("highlight mode: vias keep their brown hole, ringed in the current layer's colour", async ({ page }) => {
	await openCubliPcb(page)
	await page.evaluate(() => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const via = pcb.scene.objects.find((o: any) => o.kind === "via" && o.net === "GND")
		pcb.view(via.prims[0].x, via.prims[0].y, pcb.camera().scale * 12)
	})
	await page.mouse.move(1200, 500)
	await page.keyboard.press("+") // GND 1 current
	await page.keyboard.press("Shift+S") // highlight current
	await page.waitForTimeout(400)
	await shot(page, "pcb-highlight-vias")
	// The middle of a GND via (on GND 1) is the hole's brown, not the layer's green.
	const px = await page.evaluate(() => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const c = pcb.camera()
		const halfW = 400 / c.scale, halfH = 300 / c.scale
		const via = pcb.scene.objects.find((o: any) => o.kind === "via" && o.net === "GND" && Math.abs(o.prims[0].x - c.cx) < halfW && Math.abs(o.prims[0].y - c.cy) < halfH)
		const p = pcb.toClient(via.prims[0].x, via.prims[0].y)
		const ring = pcb.toClient(via.prims[0].x + (via.prims[0].r + via.holes[0].r) / 2, via.prims[0].y)
		const canvas = document.querySelector(".pcb-canvas") as HTMLCanvasElement
		const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio
		const at = (q: { x: number; y: number }) => Array.from(canvas.getContext("2d")!.getImageData(Math.round((q.x - r.left) * dpr), Math.round((q.y - r.top) * dpr), 1, 1).data.slice(0, 3))
		return { hole: at(p), ring: at(ring) }
	})
	const [hr, hg, hb] = px.hole as [number, number, number]
	expect(hr).toBeGreaterThan(hg) // brownish: red over green over blue
	expect(hg).toBeGreaterThan(hb)
	const [rr, rg] = px.ring as [number, number, number]
	expect(rg).toBeGreaterThan(rr) // GND 1 is green
})

test("highlight mode: only what is on the current layer can be hovered and picked", async ({ page }) => {
	await openCubliPcb(page)
	// U13_ESC_1: an SMD part on Top, framed in the middle of the view.
	const part = await page.evaluate(() => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const i = pcb.scene.components.findIndex((c: any) => c.designator === "U13_ESC")
		const c = pcb.scene.components[i]
		const [x0, y0, x1, y1] = c.outline
		pcb.view((x0 + x1) / 2, (y0 + y1) / 2, ((document.querySelector(".pcb-canvas") as HTMLCanvasElement).height * 0.4) / (y1 - y0))
		const b = c.box
		// Inside its box towards a corner, on the part itself: clear of its pads and of the vias
		// tucked against its pin ring.
		const mx = (b[0] + b[4]) / 2, my = (b[1] + b[5]) / 2
		for (let f = 0.95; f > 0.3; f -= 0.01) {
			const x = mx + (b[0] - mx) * f, y = my + (b[1] - my) * f
			const hit = pcb.pick(x, y)
			if (hit?.kind === "component" && hit.index === i) return { index: i, at: pcb.toClient(x, y) }
		}
		throw new Error("no point on U13_ESC picks the part")
	})
	const hovered = () => page.evaluate(() => (document.querySelector(".pcb-canvas") as any).__pcb.hover())
	await page.mouse.move(part.at.x, part.at.y)
	await expect.poll(hovered).toBe(part.index)

	// GND 1 current, highlighted: the Top part is greyed out, and neither hovers nor picks.
	await page.keyboard.press("+")
	await page.keyboard.press("Shift+S")
	await page.mouse.move(part.at.x + 3, part.at.y + 3)
	await expect.poll(hovered).toBeNull()
	// (A via passing through GND 1 there still can be.)
	await page.mouse.click(part.at.x + 3, part.at.y + 3)
	await page.waitForTimeout(200)
	await expect(page.getByRole("complementary", { name: "Component properties" })).toHaveCount(0)
	await page.keyboard.press("Escape")

	// Back to Top: it is on the current layer again.
	await page.keyboard.press("-")
	await page.mouse.move(part.at.x, part.at.y)
	await expect.poll(hovered).toBe(part.index)
	await page.mouse.click(part.at.x, part.at.y)
	await expect(page.locator(".inspector")).toContainText("U13_ESC")
})

test("highlighting the other side's outer layer: a part held by through-hole pads is not on it", async ({ page }) => {
	await page.goto("/")
	await page.getByTestId("zip-input").setInputFiles({ name: "Camera.zip", mimeType: "application/zip", buffer: zipTopLevel(join(CORPUS, "PnP/Camera"), "Camera") })
	await expect(page.locator('.sch-view[data-status="ready"][data-compiled="true"]')).toBeVisible({ timeout: 60_000 })
	await page.getByRole("tab", { name: "PCB" }).click()
	await expect(page.locator('.pcb-view[data-status="ready"]')).toBeVisible({ timeout: 60_000 })
	// MP1: a bottom-side lens holder, two through-hole mounting pads; a point inside it clear of them.
	const part = await page.evaluate(() => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const i = pcb.scene.components.findIndex((c: any) => c.designator === "MP1")
		const c = pcb.scene.components[i]
		const [x0, y0, x1, y1] = c.outline
		pcb.view((x0 + x1) / 2, (y0 + y1) / 2, ((document.querySelector(".pcb-canvas") as HTMLCanvasElement).height * 0.6) / (y1 - y0))
		const b = c.box, mx = (b[0] + b[4]) / 2, my = (b[1] + b[5]) / 2
		for (let f = 0.9; f > 0.1; f -= 0.02) {
			const hit = pcb.pick(mx + (b[0] - mx) * f, my + (b[1] - my) * f)
			if (hit?.kind === "component" && hit.index === i) return { side: c.side, index: i, at: pcb.toClient(mx + (b[0] - mx) * f, my + (b[1] - my) * f) }
		}
		throw new Error("no point on MP1 picks the part")
	})
	expect(part.side).toBe("bottom")
	const hovered = () => page.evaluate(() => (document.querySelector(".pcb-canvas") as any).__pcb.hover())
	const current = () => page.evaluate(() => (document.querySelector(".pcb-canvas") as any).__pcb.layers().current as string)
	const hover = async () => {
		await page.mouse.move(part.at.x + 2, part.at.y + 2)
		await page.mouse.move(part.at.x, part.at.y)
	}
	await hover()
	await expect.poll(hovered).toBe(part.index)

	// Top highlighted: its pads pass through Top, but the part is not on it.
	expect(await current()).toBe("TOP")
	await page.keyboard.press("Shift+S")
	await hover()
	await expect.poll(hovered).toBeNull()
	await page.mouse.click(part.at.x, part.at.y)
	await page.waitForTimeout(200)
	await expect(page.getByRole("complementary", { name: "Component properties" })).toHaveCount(0)

	// Bottom highlighted: it is.
	for (let k = 0; k < 40 && (await current()) !== "BOTTOM"; k++) await page.keyboard.press("-")
	expect(await current()).toBe("BOTTOM")
	await hover()
	await expect.poll(hovered).toBe(part.index)
})
