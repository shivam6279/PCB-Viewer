import { describe, expect, it } from "vitest"
import { extractStackup, stackupThickness } from "./stackup"

const items = (layers: Record<string, string>[]) =>
	layers.flatMap((fields, k) => Object.entries(fields).map(([key, value]) => ({ key: `V9_STACK_LAYER${k}_${key}`, value })))

describe("extractStackup", () => {
	const stack = extractStackup(
		items([
			{ NAME: "Top Overlay", LAYERID: "16973830" },
			{ NAME: "Top Solder", LAYERID: "16973834", DIELTYPE: "3", DIELCONST: "3.500", DIELHEIGHT: "0.3937mil", DIELMATERIAL: "Solder Resist" },
			{ NAME: "Top Layer", LAYERID: "16777217", COPTHICK: "1.378mil" },
			{ NAME: "Dielectric 2", LAYERID: "17039362", DIELTYPE: "2", DIELCONST: "4.100", DIELHEIGHT: "7.874mil", DIELMATERIAL: "PP-006" },
			{ NAME: "Signal 1", LAYERID: "16777218", COPTHICK: "0.689mil" },
			{ NAME: "Dielectric 1", LAYERID: "17039361", DIELTYPE: "0", DIELCONST: "4.800", DIELHEIGHT: "25.6299mil", DIELMATERIAL: "FR-4" },
			{ NAME: "Unused", LAYERID: "17039370", DIELTYPE: "0", DIELHEIGHT: "0mil" },
			{ NAME: "Bottom Layer", LAYERID: "16842751", COPTHICK: "1.378mil" },
			{ NAME: "Bottom Paste", LAYERID: "16973833" },
		]),
	)

	it("reads every layer top to bottom with its kind", () => {
		expect(stack.map(l => [l.name, l.kind, l.key])).toEqual([
			["Top Overlay", "overlay", null],
			["Top Solder", "mask", null],
			["Top Layer", "signal", "TOP"],
			["Dielectric 2", "prepreg", null],
			["Signal 1", "signal", "MID-LAYER1"],
			["Dielectric 1", "core", null],
			["Bottom Layer", "signal", "BOTTOM"],
			["Bottom Paste", "paste", null],
		])
	})

	it("reads thickness, material, dielectric constant and copper weight", () => {
		expect(stack[3]).toMatchObject({ thickness: 7.874, material: "PP-006", dk: 4.1 })
		expect(stack[2]!.weight).toBe(1)
		expect(stack[4]!.weight).toBe(0.5)
		expect(stackupThickness(stack)).toBeCloseTo(0.3937 + 1.378 + 7.874 + 0.689 + 25.6299 + 1.378, 6)
	})
})
