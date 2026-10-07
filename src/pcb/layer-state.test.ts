import { describe, expect, it } from "vitest"
import { cycleCurrent, makeCurrent, nextMode, onlyLayer, type LayerState } from "./layer-state"
import type { PcbScene } from "./scene"

const layer = (key: string, group: string) => ({ key, group }) as PcbScene["layers"][number]
// Scene order is drawing order; the legend lists by group (copper first).
const scene = { layers: [layer("TOPOVERLAY", "silk"), layer("TOP", "copper"), layer("MID-LAYER1", "copper"), layer("BOTTOM", "copper"), layer("MECHANICAL1", "mech")] } as PcbScene
const state = (extra: Partial<LayerState> = {}): LayerState => ({
	visible: new Set(["TOP", "MID-LAYER1", "BOTTOM", "TOPOVERLAY"]),
	current: "TOP",
	mode: "all",
	flip: false,
	hiddenKinds: new Set(),
	...extra,
})

describe("layer state", () => {
	it("cycles the mode all -> highlight -> only -> all", () => {
		const a = state()
		const b = nextMode(a)
		const c = nextMode(b)
		expect([b.mode, c.mode, nextMode(c).mode]).toEqual(["highlight", "only", "all"])
		expect(onlyLayer(c)).toBe("TOP")
		expect(onlyLayer(b)).toBeNull()
	})

	it("cycles the current layer through the visible layers in legend order, wrapping", () => {
		let s = state()
		const seen: string[] = []
		for (let i = 0; i < 5; i++) seen.push((s = cycleCurrent(s, scene, 1)).current)
		// Mechanical 1 is hidden: skipped.
		expect(seen).toEqual(["MID-LAYER1", "BOTTOM", "TOPOVERLAY", "TOP", "MID-LAYER1"])
		expect(cycleCurrent(state(), scene, -1).current).toBe("TOPOVERLAY")
	})

	it("picking a hidden layer shows it", () => {
		const s = makeCurrent(state(), "MECHANICAL1")
		expect(s.current).toBe("MECHANICAL1")
		expect(s.visible.has("MECHANICAL1")).toBe(true)
	})
})
