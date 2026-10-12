// How a selection (from either view) maps onto the board: which objects stay coloured, which get the
// selection outline, and what to frame. Schematic nets and components reach the board through the
// PCB net name (the compiled physical name) and Altium's component source path. Pure.
import type { Selection } from "../app/store"
import type { CompiledProject } from "../model/compile"
import type { PcbHit } from "./hit"
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

// A board part's lasting name: its source path (unique per channel, and the same in another commit);
// a part the schematic does not have, its place in the board's list. Designators repeat across channels.
export function partKey(scene: PcbScene, index: number): string {
	return scene.components[index]?.sourceUniqueId || `#${index}`
}

export function partIndex(scene: PcbScene, key: string): number {
	return key.startsWith("#") ? Number(key.slice(1)) : scene.components.findIndex(c => c.sourceUniqueId === key)
}

// A pick (an object or a part) as the shared selection.
export function hitSelection(scene: PcbScene, hit: PcbHit, compiled: CompiledProject | null): Selection {
	return hit.kind === "object" ? { kind: "pcbObject", id: hit.id } : componentSelection(scene, hit.index, compiled)
}

// Where the selection is in a stack of picks, or -1.
export function hitPosition(scene: PcbScene, hits: PcbHit[], selection: Selection | null, compiled: CompiledProject | null): number {
	if (!selection) return -1
	const part = selection.kind === "pcbComponent" ? selection.index : selection.kind === "component" ? pcbComponentIndex(scene, compiled, selection.id) : -1
	return hits.findIndex(h => (h.kind === "object" ? selection.kind === "pcbObject" && selection.id === h.id : h.index === part))
}

// The part whose pads a click can reach: the selected part, or the part of a selected pad.
export function openPart(scene: PcbScene, selection: Selection | null, compiled: CompiledProject | null): number | null {
	if (!selection) return null
	if (selection.kind === "pcbComponent") return selection.index
	if (selection.kind === "component") {
		const i = pcbComponentIndex(scene, compiled, selection.id)
		return i >= 0 ? i : null
	}
	if (selection.kind === "pcbObject") {
		const o = scene.objects[selection.id]
		return o?.kind === "pad" ? o.component : null
	}
	return null
}

// Whether a pick is part of what is selected: the selected part itself, or an object the selection
// holds (a pad of the selected part, copper of the selected net). A click anywhere else only clears it.
export function hitInSelection(scene: PcbScene, hit: PcbHit, selection: Selection | null, compiled: CompiledProject | null): boolean {
	if (!selection) return false
	// A selected pad keeps its part open: another pad of it, or the part itself, is a click inside.
	const pad = selection.kind === "pcbObject" ? scene.objects[selection.id] : undefined
	if (pad?.kind === "pad" && pad.component !== null)
		return hit.kind === "component" ? hit.index === pad.component : scene.objects[hit.id]?.component === pad.component
	if (hit.kind === "component") return hitPosition(scene, [hit], selection, compiled) === 0
	return pcbHighlight(scene, selection, compiled)?.objects.has(hit.id) ?? false
}

// What a pick is, for a menu row: its kind, its name, and a detail (net, layer, part value).
export function hitLabel(scene: PcbScene, hit: PcbHit, compiled: CompiledProject | null): { kind: string; label: string; detail: string } {
	if (hit.kind === "component") {
		const c = scene.components[hit.index]!
		return { kind: "Part", label: partLabel(scene, hit.index, compiled), detail: [c.comment, c.footprint].filter(Boolean).join(" · ") }
	}
	const o = scene.objects[hit.id]!
	const layer = scene.layers.find(l => l.key === o.layer)?.name ?? o.layer
	const net = o.net ?? "No net"
	if (o.kind === "pad") {
		const owner = o.component !== null ? partLabel(scene, o.component, compiled) : ""
		return { kind: "Pad", label: owner ? `${owner}-${o.pad?.name ?? ""}` : (o.pad?.name ?? "Pad"), detail: net }
	}
	if (o.kind === "via") return { kind: "Via", label: net, detail: o.span ? o.span.map(k => scene.layers.find(l => l.key === k)?.name ?? k).join(" – ") : "" }
	const kind = o.kind === "region" ? (o.pour ? "Polygon" : "Region") : o.kind === "fill" ? "Fill" : o.kind === "arc" ? "Arc" : "Track"
	return { kind, label: net, detail: layer }
}

// The part's designator as the schematic shows it (with its channel), else the board's.
export function partLabel(scene: PcbScene, index: number, compiled: CompiledProject | null): string {
	const c = scene.components[index]
	const placed = c?.sourceUniqueId ? compiled?.components.find(p => p.uniquePath === c.sourceUniqueId) : undefined
	return placed?.designator ?? c?.designator ?? ""
}
