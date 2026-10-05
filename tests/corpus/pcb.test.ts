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
