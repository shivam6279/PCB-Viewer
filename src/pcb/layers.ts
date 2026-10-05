// PCB layer names, colours and drawing order. Pure data; no altiumts types.
//
// Layer tokens are the binary PcbDoc's (TOP, MID-LAYER3, BOTTOM, TOPOVERLAY, MECHANICAL4, MULTILAYER…).
// Colours are the default 2D scheme, keyed by the layer's identity (V7 number): on Cubli "GND 1" is
// internally Mid-Layer 3 and is drawn green.

export type LayerGroup = "copper" | "mask" | "paste" | "silk" | "mech" | "other"

export interface PcbLayer {
	key: string // primitive LAYER token, e.g. "MID-LAYER3"
	name: string // the board's name, e.g. "GND 1"
	color: string
	group: LayerGroup
	side: "top" | "bottom" | "inner" | "none"
	stack: number // copper: position in the stackup from the top (0 = Top Layer)
	z?: number // copper: depth of the copper's mid-plane below the board top, mils (from the stackup)
}

const MID_COLORS = ["#bc8e00", "#70dbfa", "#00cc66", "#9933ff", "#00ffff", "#800080", "#ff00ff", "#808000", "#ffff00", "#808080", "#ffffff", "#800000", "#008000", "#00ff00", "#000080"]
const MECH_COLORS = ["#ff00ff", "#800080", "#008000", "#808000"]
const PLANE_COLORS = ["#00ff00", "#800000", "#00ffff", "#808000"]

const FIXED: Record<string, { color: string; group: LayerGroup; side: PcbLayer["side"]; name: string; v7: number }> = {
	TOP: { color: "#ff0000", group: "copper", side: "top", name: "Top Layer", v7: 1 },
	BOTTOM: { color: "#0000ff", group: "copper", side: "bottom", name: "Bottom Layer", v7: 32 },
	TOPOVERLAY: { color: "#ffff00", group: "silk", side: "top", name: "Top Overlay", v7: 33 },
	BOTTOMOVERLAY: { color: "#808000", group: "silk", side: "bottom", name: "Bottom Overlay", v7: 34 },
	TOPPASTE: { color: "#808080", group: "paste", side: "top", name: "Top Paste", v7: 35 },
	BOTTOMPASTE: { color: "#800000", group: "paste", side: "bottom", name: "Bottom Paste", v7: 36 },
	TOPSOLDER: { color: "#800080", group: "mask", side: "top", name: "Top Solder", v7: 37 },
	BOTTOMSOLDER: { color: "#ff00ff", group: "mask", side: "bottom", name: "Bottom Solder", v7: 38 },
	DRILLGUIDE: { color: "#800000", group: "other", side: "none", name: "Drill Guide", v7: 55 },
	KEEPOUT: { color: "#ff00ff", group: "other", side: "none", name: "Keep-Out Layer", v7: 56 },
	DRILLDRAWING: { color: "#ff002a", group: "other", side: "none", name: "Drill Drawing", v7: 73 },
	MULTILAYER: { color: "#c0c0c0", group: "other", side: "none", name: "Multi-Layer", v7: 74 },
}

export const MID = /^MID(?:-LAYER)?(\d+)$/
const MECH = /^MECHANICAL(\d+)$/
const PLANE = /^(?:INTERNALPLANE|PLANE)(\d+)$/

// The V7 layer number, which indexes the board's LAYERnNAME fields.
export function v7Number(key: string): number | null {
	if (FIXED[key]) return FIXED[key].v7
	const mid = MID.exec(key)
	if (mid) return 1 + Number(mid[1])
	const plane = PLANE.exec(key)
	if (plane) return 38 + Number(plane[1])
	const mech = MECH.exec(key)
	if (mech) return 56 + Number(mech[1])
	return null
}

export function describeLayer(key: string, boardName: (v7: number) => string | undefined): Omit<PcbLayer, "stack"> {
	const v7 = v7Number(key)
	const named = (fallback: string) => (v7 !== null ? boardName(v7) : undefined) || fallback
	const fixed = FIXED[key]
	if (fixed) return { key, name: fixed.group === "copper" ? named(fixed.name) : fixed.name, color: fixed.color, group: fixed.group, side: fixed.side }
	const mid = MID.exec(key)
	if (mid) {
		const n = Number(mid[1])
		return { key, name: named(`Mid-Layer ${n}`), color: MID_COLORS[(n - 1) % MID_COLORS.length]!, group: "copper", side: "inner" }
	}
	const plane = PLANE.exec(key)
	if (plane) {
		const n = Number(plane[1])
		return { key, name: named(`Internal Plane ${n}`), color: PLANE_COLORS[(n - 1) % PLANE_COLORS.length]!, group: "copper", side: "inner" }
	}
	const mech = MECH.exec(key)
	if (mech) {
		const n = Number(mech[1])
		return { key, name: named(`Mechanical ${n}`), color: MECH_COLORS[(n - 1) % MECH_COLORS.length]!, group: "mech", side: "none" }
	}
	return { key, name: key, color: "#808080", group: "other", side: "none" }
}

export const GROUP_ORDER: LayerGroup[] = ["copper", "mask", "paste", "silk", "mech", "other"]
export const GROUP_NAMES: Record<LayerGroup, string> = {
	copper: "Copper",
	mask: "Solder Mask",
	paste: "Paste Mask",
	silk: "Silkscreen",
	mech: "Mechanical",
	other: "Other",
}

// Back-to-front drawing order for a top-side view. The current layer is lifted above the other
// copper; overlays, masks and paste of the viewed side stay above copper.
export function drawOrder(layers: PcbLayer[], current: string, side: "top" | "bottom"): string[] {
	const copper = layers.filter(l => l.group === "copper").sort((a, b) => b.stack - a.stack) // bottom first
	if (side === "bottom") copper.reverse()
	const near = side === "top" ? "top" : "bottom"
	const far = side === "top" ? "bottom" : "top"
	const pick = (group: LayerGroup, s: PcbLayer["side"]) => layers.filter(l => l.group === group && l.side === s).map(l => l.key)
	// Masks and paste sit under the copper: a pad reads as copper, not paste.
	const order = [
		...layers.filter(l => l.group === "mech").map(l => l.key),
		...pick("paste", far),
		...pick("mask", far),
		...pick("silk", far),
		...pick("mask", near),
		...pick("paste", near),
		...copper.map(l => l.key),
		...layers.filter(l => l.key === "MULTILAYER").map(l => l.key),
		...pick("silk", near),
		...layers.filter(l => l.group === "other" && l.key !== "MULTILAYER").map(l => l.key),
	]
	// The current copper layer is drawn above the other copper; vias and through-hole pads
	// (Multi-Layer) stay on top of it.
	const i = order.indexOf(current)
	if (i >= 0 && layers.find(l => l.key === current)?.group === "copper") {
		order.splice(i, 1)
		const multi = order.indexOf("MULTILAYER")
		const lastCopper = Math.max(...order.map((k, n) => (layers.find(l => l.key === k)?.group === "copper" ? n : -1)))
		order.splice(multi >= 0 ? multi : lastCopper + 1, 0, current)
	}
	return order
}
