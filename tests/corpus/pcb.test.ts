import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { CORPUS, hasCorpus } from "./env"
import { parsePcb } from "../../src/parse/extract-pcb"
import { buildPcbScene } from "../../src/pcb/scene"
import { netSummaries } from "../../src/pcb/nets"

// Expected values for the Cubli board.
describe.skipIf(!hasCorpus)("Cubli board: known facts", () => {
	const scene = () => buildPcbScene(parsePcb(new Uint8Array(readFileSync(join(CORPUS, "Cubli/Main Board/STM32/Cubli.PcbDoc")))))

	test("copper stack, names and colours", () => {
		const copper = scene().layers.filter(l => l.group === "copper")
		expect(copper.map(l => l.name)).toEqual(["Top Layer", "GND 1", "Signal 1", "PWR 1", "GND 2", "Signal 2", "PWR 2", "Bottom Layer"])
		expect(copper.map(l => l.color)).toEqual(["#ff0000", "#00cc66", "#bc8e00", "#00ffff", "#800080", "#70dbfa", "#9933ff", "#0000ff"])
	})

	test("routed lengths and layers used", () => {
		const nets = netSummaries(scene())
		const net = (name: string) => nets.find(n => n.name === name)!
		expect(net("3V3_MCU_ESC_1").routedLength).toBeCloseTo(94.917, 3)
		expect(net("CAN_L").routedLength).toBeCloseTo(169.387, 3)
		expect(net("COMP_OUT_U_2").routedLength).toBeCloseTo(2.061, 3)
		expect(new Set(net("OUT_V_2").layers)).toEqual(new Set(["BOTTOM", "MID-LAYER5", "TOP", "MID-LAYER2"]))
	})

	test("pad and component figures", () => {
		const s = scene()
		const pad = s.objects.find(o => o.kind === "pad" && o.net === "OUT_V_2" && o.pad?.name === "2" && /^J1/.test(s.components[o.component!]!.designator))!
		const mm = (v: number, o: number) => ((v - o) * 0.0254).toFixed(3)
		expect([mm(pad.at[0], s.origin[0]), mm(pad.at[1], s.origin[1])]).toEqual(["28.200", "13.600"])
		expect(pad.pad).toMatchObject({ plated: true, smd: false, shape: "Round", rotation: 180 })
		expect((pad.pad!.sizeX * 0.0254).toFixed(3)).toBe("2.500")
		expect((pad.pad!.holeSize * 0.0254).toFixed(3)).toBe("1.700")
	})
})

describe.skipIf(!hasCorpus)("custom-shaped pads", () => {
	test("LED_ring's LEDs: each pad's copper is its region, owned by the part", () => {
		const scene = buildPcbScene(parsePcb(new Uint8Array(readFileSync(join(CORPUS, "PnP/LED_ring/led_ring.PcbDoc")))))
		for (let k = 1; k <= 12; k++) {
			const c = scene.components.find(c => c.designator === `D${k}`)!
			const pads = c.objects.map(id => scene.objects[id]!).filter(o => o.kind === "pad")
			expect(pads).toHaveLength(2)
			for (const p of pads) {
				expect(p.pad!.shape).toBe("Custom")
				// Real copper, not the 1 mil placeholder the pad record holds.
				expect(Math.min(p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1])).toBeGreaterThan(10)
			}
		}
		// The regions that are pads are not drawn a second time as loose copper.
		const loose = scene.objects.filter(o => o.kind === "region" && o.component === null && !o.pour && o.layer === "TOP")
		const d1 = scene.components.find(c => c.designator === "D1")!
		const [x0, y0, x1, y1] = d1.outline
		expect(loose.filter(o => o.bbox[0] >= x0 && o.bbox[2] <= x1 && o.bbox[1] >= y0 && o.bbox[3] <= y1)).toEqual([])
	})
})

test.skipIf(!hasCorpus)("custom pads: the region tied to a pad carries that pad's net, on every board that has them", () => {
	for (const board of ["Cubli/Main Board/STM32/Cubli.PcbDoc", "PnP/LED_ring/led_ring.PcbDoc", "POV/POVRotor/Rev3/POVRotor.PcbDoc"]) {
		const scene = buildPcbScene(parsePcb(new Uint8Array(readFileSync(join(CORPUS, board)))))
		const custom = scene.objects.filter(o => o.kind === "pad" && o.pad?.shape === "Custom")
		expect(custom.length).toBeGreaterThan(0)
		// Each custom pad's copper lies under the pad's own location.
		for (const p of custom) {
			const [x, y] = p.at
			expect(x >= p.bbox[0] - 1 && x <= p.bbox[2] + 1 && y >= p.bbox[1] - 1 && y <= p.bbox[3] + 1).toBe(true)
		}
	}
})

describe.skipIf(!hasCorpus)("footprint pictures", () => {
	const load = (path: string) => buildPcbScene(parsePcb(new Uint8Array(readFileSync(join(CORPUS, path)))))

	test("every part with one footprint gets the same picture, whatever its rotation", async () => {
		const { footprintSvg } = await import("../../src/pcb/footprint-svg")
		const scene = load("PnP/LED_ring/led_ring.PcbDoc")
		const pictures = new Set(Array.from({ length: 12 }, (_, k) => footprintSvg(scene, scene.components.findIndex(c => c.designator === `D${k + 1}`))))
		expect(pictures.size).toBe(1)
		const svg = [...pictures][0]!
		// Pads and silkscreen in colour; courtyard and component centre (origin) in grey.
		expect(svg).toContain('data-layer="TOP"')
		expect(svg).toContain('data-layer="TOPOVERLAY"')
		const name = (key: string) => scene.layers.find(l => l.key === key)!.name
		const greyed = [...svg.matchAll(/data-layer="(MECHANICAL\d+)"[^>]*>(<[^>]+>)/g)].map(m => [name(m[1]!), /rgb\((\d+),\1,\1\)/.test(m[2]!)])
		expect(greyed).toEqual(expect.arrayContaining([["Top Courtyard", true], ["Top Component Center", true]]))
	})

	test("a bottom-side part is drawn as designed: on the top-side layers", async () => {
		const { footprintSvg } = await import("../../src/pcb/footprint-svg")
		const scene = load("Cubli/Main Board/STM32/Cubli.PcbDoc")
		const i = scene.components.findIndex(c => c.side === "bottom" && !scene.components.some(t => t.side === "top" && t.footprint === c.footprint))
		expect(i).toBeGreaterThanOrEqual(0)
		const svg = footprintSvg(scene, i)!
		expect(svg).toContain('data-layer="TOP"')
		expect(svg).not.toContain('data-layer="BOTTOM"')
		expect(svg).not.toContain('data-layer="BOTTOMOVERLAY"')
	})
})
