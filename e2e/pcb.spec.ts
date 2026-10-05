import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { hasCorpus } from "../tests/corpus/env"
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

test("the layers panel: Only shows one layer, Bottom mirrors the board, +/- changes the current layer", async ({ page }) => {
	await openCubliPcb(page) // the Layers/Objects panel is open from the start
	const panel = page.getByRole("complementary", { name: "Layers and objects" })
	await expect(panel.locator(".pcb-layer-row")).toContainText(["Top Layer", "GND 1", "Signal 1", "PWR 1", "GND 2", "Signal 2", "PWR 2", "Bottom Layer"])
	await expect(panel.getByRole("checkbox", { name: "Current layer Top Layer" })).toBeChecked()
	const row = panel.locator('.pcb-layer-row[data-layer="MID-LAYER3"]')
	await row.hover()
	await row.getByRole("button", { name: "Only" }).click()
	await expect(panel.locator('.pcb-layer-row:not(.hidden)')).toHaveCount(1)
	await shot(page, "pcb-only-gnd1")
	await panel.getByRole("button", { name: "Reset" }).click()
	await expect(panel.locator('.pcb-layer-row[data-layer="TOP"]')).not.toHaveClass(/hidden/)

	await panel.getByRole("button", { name: "Bottom", exact: true }).click()
	await expect.poll(() => page.evaluate(() => ((document.querySelector(".pcb-canvas") as any).__pcb as Pcb).camera().flip)).toBe(true)
	await shot(page, "pcb-bottom")
	await panel.getByRole("button", { name: "Top", exact: true }).click()

	await page.mouse.move(1000, 500)
	await page.keyboard.press("+")
	await expect(panel.getByRole("checkbox", { name: "Current layer GND 1" })).toBeChecked()
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
	await openCubliPcb(page) // the Layers/Objects panel is open from the start
	const row = page.locator('.pcb-layer-row[data-layer="TOP"]')
	await row.hover()
	await row.getByRole("button", { name: "Only" }).click()
	await page.getByRole("button", { name: "Layers/Objects" }).click()
	const p = await partPoint(page, BOTTOM_PART)
	await page.evaluate(i => {
		const pcb = (document.querySelector(".pcb-canvas") as any).__pcb
		const c = pcb.scene.components[i]
		pcb.view((c.outline[0] + c.outline[2]) / 2, (c.outline[1] + c.outline[3]) / 2, pcb.camera().scale * 8)
	}, p.index)
	const q = await partPoint(page, BOTTOM_PART)
	await page.mouse.move(q.x, q.y)
	await page.mouse.click(q.x, q.y)
	await page.waitForTimeout(200)
	await expect(page.getByRole("complementary", { name: "Component properties" })).toHaveCount(0)
	expect(await page.evaluate(() => (document.querySelector(".pcb-canvas") as any).__pcb.hover())).not.toBe(p.index)
})

test("double-clicking a track selects its whole net", async ({ page }) => {
	await openCubliPcb(page)
	const TRACK = `s.objects.filter(o => o.kind === "track" && o.net && o.layer === "TOP" && (p => { const h = (document.querySelector(".pcb-canvas")).__pcb.pick((p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2); return h && h.kind === "object" && h.id === o.id })(o.prims[0])).sort((a, b) => b.length - a.length)[0]`
	await zoomTo(page, TRACK, 4)
	const p = await clientOf(page, TRACK)
	const net = await page.evaluate(src => new Function("s", `return (${src}).net`)((document.querySelector(".pcb-canvas") as any).__pcb.scene), TRACK)
	await page.mouse.dblclick(p.x, p.y)
	const panel = page.getByRole("complementary", { name: "Net properties" })
	await expect(panel).toBeVisible()
	await expect(panel.locator(".inspector-head .title")).toHaveText(net)
	await shot(page, "pcb-dblclick-net")
})

test("leaving the PCB tab and coming back keeps the view and layers", async ({ page }) => {
	await openCubliPcb(page) // the Layers/Objects panel is open from the start
	const row = page.locator('.pcb-layer-row[data-layer="TOP"]')
	await row.hover()
	await row.getByRole("button", { name: "Only" }).click()
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
	await expect(page.locator(".pcb-layer-row:not(.hidden)")).toHaveCount(1)
})
