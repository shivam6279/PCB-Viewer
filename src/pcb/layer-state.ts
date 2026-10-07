// What the PCB view shows: which layers are on, the current layer, how the other layers are drawn
// against it, and whether the board is mirrored (seen from the bottom).
import { GROUP_ORDER } from "./layers"
import type { PcbScene } from "./scene"

// all: every visible layer as it is; highlight: the current layer in colour over the others, greyed
// and dark; only: the current layer alone (with the vias and through-hole pads passing through it).
export type LayerMode = "all" | "highlight" | "only"
export const LAYER_MODES: LayerMode[] = ["all", "highlight", "only"]
export const MODE_NAMES: Record<LayerMode, string> = { all: "All layers", highlight: "Highlight current", only: "Current only" }

export interface LayerState {
	visible: Set<string>
	current: string
	mode: LayerMode
	flip: boolean // mirrored left-right: the board seen from the bottom
	hiddenKinds: Set<string>
}

// The layer single-layer mode shows, if it is on.
export const onlyLayer = (s: LayerState) => (s.mode === "only" ? s.current : null)

export const nextMode = (s: LayerState): LayerState => ({ ...s, mode: LAYER_MODES[(LAYER_MODES.indexOf(s.mode) + 1) % LAYER_MODES.length]! })

// The layers in the order the legend lists them: by group, then the scene's order within a group.
export function legendOrder(scene: PcbScene) {
	return GROUP_ORDER.flatMap(g => scene.layers.filter(l => l.group === g))
}

// The next (dir 1) or previous (-1) visible layer becomes current, wrapping around.
export function cycleCurrent(s: LayerState, scene: PcbScene, dir: 1 | -1): LayerState {
	const keys = legendOrder(scene)
		.map(l => l.key)
		.filter(k => s.visible.has(k) || k === s.current)
	if (keys.length === 0) return s
	const i = keys.indexOf(s.current)
	const next = keys[(i + dir + keys.length) % keys.length]!
	return next === s.current ? s : { ...s, current: next }
}

// Picking a layer in the legend makes it current (and shows it, if it was off).
export function makeCurrent(s: LayerState, key: string): LayerState {
	const visible = s.visible.has(key) ? s.visible : new Set([...s.visible, key])
	return { ...s, current: key, visible }
}

export function toggleVisible(s: LayerState, key: string): LayerState {
	const visible = new Set(s.visible)
	if (visible.has(key)) visible.delete(key)
	else visible.add(key)
	return { ...s, visible }
}
