// How a selection (from either view) maps onto the board: which objects stay coloured, which get the
// selection outline, and what to frame. Schematic nets and components reach the board through the
// PCB net name (the compiled physical name) and Altium's component source path. Pure.
import type { Selection } from "../app/store"
import type { CompiledProject } from "../model/compile"
import type { PcbScene } from "./scene"

export interface PcbHighlight {
	objects: Set<number>
	outline: Set<number> | null
	componentBox: number[] | null // four corners
	frame: [number, number, number, number] | null
}

export function pcbComponentIndex(scene: PcbScene, compiled: CompiledProject | null, componentId: string): number {
	const c = compiled?.components.find(c => c.id === componentId)
	return c ? scene.components.findIndex(p => p.sourceUniqueId === c.uniquePath) : -1
}

// The PCB net name a selection stands for, if it is a net.
export function pcbNetName(selection: Selection, compiled: CompiledProject | null): string | null {
	if (selection.kind === "pcbNet") return selection.name
	if (selection.kind === "net") return compiled?.nets[selection.netId]?.physicalName ?? null
	return null
}

// A board net as the selection both views share: the compiled net when the schematic has it.
export function netSelection(name: string, compiled: CompiledProject | null): Selection {
	const upper = name.toUpperCase()
	const net = compiled?.nets.find(n => n.physicalName.toUpperCase() === upper)
	return net ? { kind: "net", netId: net.id } : { kind: "pcbNet", name }
}

// A board component as the shared selection: the compiled component when the schematic has it.
export function componentSelection(scene: PcbScene, index: number, compiled: CompiledProject | null): Selection {
	const path = scene.components[index]?.sourceUniqueId
	const c = path ? compiled?.components.find(c => c.uniquePath === path) : undefined
	return c ? { kind: "component", id: c.id } : { kind: "pcbComponent", index }
}

export function pcbHighlight(scene: PcbScene, selection: Selection | null, compiled: CompiledProject | null): PcbHighlight | null {
	if (!selection) return null
	const box = (ids: Iterable<number>) => {
		let b: [number, number, number, number] | null = null
		for (const id of ids) {
			const o = scene.objects[id]!
			b = b ? [Math.min(b[0], o.bbox[0]), Math.min(b[1], o.bbox[1]), Math.max(b[2], o.bbox[2]), Math.max(b[3], o.bbox[3])] : [...o.bbox]
		}
		return b
	}
	if (selection.kind === "pcbObject") {
		const o = scene.objects[selection.id]
		if (!o) return null
		const ids = new Set([o.id])
		return { objects: ids, outline: o.kind === "pad" || o.kind === "via" ? ids : null, componentBox: null, frame: box(ids) }
	}
	const name = pcbNetName(selection, compiled)
	if (name !== null) {
		const upper = name.toUpperCase()
		const ids = new Set(scene.objects.filter(o => o.net !== null && o.net.toUpperCase() === upper).map(o => o.id))
		return { objects: ids, outline: null, componentBox: null, frame: ids.size ? box(ids) : null }
	}
	const index =
		selection.kind === "pcbComponent" ? selection.index : selection.kind === "component" ? pcbComponentIndex(scene, compiled, selection.id) : -1
	const c = scene.components[index]
	if (!c) return { objects: new Set(), outline: null, componentBox: null, frame: null }
	// A selected part shows as a hatched green box with its pads in layer colour (no pad outline).
	return { objects: new Set(c.objects), outline: null, componentBox: c.box, frame: c.bbox }
}
