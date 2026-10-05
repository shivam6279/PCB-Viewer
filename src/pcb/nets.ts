// Per-net figures for the panels:
// routed length = tracks + arcs on copper + every via barrel between the outermost
// copper layers the net connects to at that hole (measured between those layers' copper mid-planes);
// layers used = copper layers holding any of the net's objects (pours included). Pure.
import type { PcbNet } from "../parse/extract-pcb"
import { primContains } from "./hit"
import type { PcbScene } from "./scene"

const MM = 0.0254

export function netSummaries(scene: PcbScene): PcbNet[] {
	const copper = new Map(scene.layers.filter(l => l.group === "copper").map(l => [l.key, l]))
	const byNet = new Map<string, { length: number; layers: Set<string>; objects: number[] }>()
	for (const o of scene.objects) {
		if (!o.net) continue
		let n = byNet.get(o.net)
		if (!n) byNet.set(o.net, (n = { length: 0, layers: new Set(), objects: [] }))
		n.objects.push(o.id)
		if (copper.has(o.layer)) {
			n.layers.add(o.layer)
			if (o.kind === "track" || o.kind === "arc") n.length += o.length ?? 0
		}
	}
	for (const n of byNet.values()) {
		const objects = n.objects.map(id => scene.objects[id]!)
		for (const hole of objects) {
			// Through-hole pads are not counted, only vias.
			if (hole.kind !== "via") continue
			const [x, y] = hole.at
			const z = objects
				.filter(o => o !== hole && copper.has(o.layer) && o.prims.some(p => primContains(p, x, y, 0.5)))
				.map(o => copper.get(o.layer)!.z)
				.filter((v): v is number => v !== undefined)
			if (z.length >= 2) n.length += Math.max(...z) - Math.min(...z)
		}
	}
	const stack = (key: string) => copper.get(key)?.stack ?? 999
	// Top and Bottom first, then the inner layers.
	const rank = (key: string) => (key === "TOP" ? -2 : key === "BOTTOM" ? -1 : stack(key))
	return [...byNet].map(([name, n]) => ({ name, routedLength: n.length * MM, layers: [...n.layers].sort((a, b) => rank(a) - rank(b)) }))
}
