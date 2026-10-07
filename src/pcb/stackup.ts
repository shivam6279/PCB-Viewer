// The board's layer stack as the format stores it (the V9 stack records of the board), top to bottom:
// overlays and paste (no thickness), solder masks, copper and the dielectrics between them.
export type StackupKind = "overlay" | "paste" | "mask" | "signal" | "plane" | "core" | "prepreg"

export interface StackupLayer {
	name: string
	kind: StackupKind
	key: string | null // copper: the scene's layer key (TOP, MID-LAYER3, PLANE1, BOTTOM)
	thickness: number // mils (0: overlay, paste)
	material: string
	dk: number | null // dielectric constant
	weight: number | null // copper weight, oz
}

// The format's layer ids.
const TOP = 16777217
const BOTTOM = 16842751
const OVERLAY = [16973830, 16973831]
const PASTE = [16973832, 16973833]
const MASK = [16973834, 16973835]
const OZ = 1.378 // mils of copper per ounce

export function copperKeyOfId(id: number): string | null {
	if (id === TOP) return "TOP"
	if (id === BOTTOM) return "BOTTOM"
	if (id > TOP && id < TOP + 31) return `MID-LAYER${id - TOP}`
	if (id > BOTTOM && id < BOTTOM + 17) return `PLANE${id - BOTTOM}`
	return null
}

const mils = (value: string | undefined) => Number.parseFloat(value ?? "") || 0
const number = (value: string | undefined) => {
	const n = Number.parseFloat(value ?? "")
	return Number.isFinite(n) ? n : null
}

export function extractStackup(boardItems: { key: string; value: string }[]): StackupLayer[] {
	const fields = new Map(boardItems.map(i => [i.key.toUpperCase(), i.value]))
	const out: StackupLayer[] = []
	for (let k = 0; ; k++) {
		const field = (name: string) => fields.get(`V9_STACK_LAYER${k}_${name}`)
		const idText = field("LAYERID")
		if (idText === undefined) break
		const id = Number(idText)
		const name = field("NAME") ?? ""
		const key = copperKeyOfId(id)
		if (key) {
			const thickness = number(field("COPTHICK")) ?? OZ
			out.push({ name, kind: key.startsWith("PLANE") ? "plane" : "signal", key, thickness, material: "Copper", dk: null, weight: Math.round((thickness / OZ) * 4) / 4 })
		} else if (OVERLAY.includes(id) || PASTE.includes(id)) {
			out.push({ name, kind: OVERLAY.includes(id) ? "overlay" : "paste", key: null, thickness: 0, material: "", dk: null, weight: null })
		} else {
			const thickness = mils(field("DIELHEIGHT"))
			if (thickness <= 0 && !MASK.includes(id)) continue
			const kind: StackupKind = MASK.includes(id) || field("DIELTYPE") === "3" ? "mask" : field("DIELTYPE") === "2" ? "prepreg" : "core"
			out.push({ name, kind, key: null, thickness, material: field("DIELMATERIAL") ?? "", dk: number(field("DIELCONST")), weight: null })
		}
	}
	return out
}

export const stackupThickness = (layers: StackupLayer[]) => layers.reduce((t, l) => t + l.thickness, 0)
