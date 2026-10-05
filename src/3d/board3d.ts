// altiumts PcbDoc -> what the 3D view needs beyond the 2D scene: the board's thickness, its 3D colours
// (the view configuration Altium saves inside the board, e.g. "Altium 3D White"), and every component
// body: an embedded STEP model placed on the board, or an extruded outline. Runs in the parse worker;
// plain data. Lengths are board mils (absolute, as in the PCB scene), angles degrees.
import type { AltiumBinaryPcbDoc } from "altiumts"

export type Rgb = [number, number, number] // 0..1

export interface Board3dColors {
	background: Rgb
	core: Rgb
	coreOpacity: number
	prepreg: Rgb
	prepregOpacity: number
	topMask: Rgb
	topMaskOpacity: number
	bottomMask: Rgb
	bottomMaskOpacity: number
	copper: Rgb
	topSilk: Rgb
	bottomSilk: Rgb
}

export interface Board3dBody {
	component: number | null // index into the scene's components
	side: "top" | "bottom"
	// The footprint-side projection of the body (rings of x,y), its z range above the board surface.
	contour: number[][]
	standoff: number
	height: number
	color: Rgb
	opacity: number
	// An embedded STEP model (key into Board3d.models), placed by its stored offsets; null = extrude the contour.
	model: string | null
	// Placement (every body's placed model matches its contour and height):
	//   top:    world = T(x, y, dz) · Rz(rz) · Ry(ry) · Rx(rx) · model
	//   bottom: world = T(x, y, -dz) · Rx(180°) · Rz(rz) · Ry(ry) · Rx(rx) · model   (z from the bottom surface)
	// The rotations already include the component's own rotation.
	x: number
	y: number
	rx: number
	ry: number
	rz: number
	dz: number
}

export interface Board3dModel {
	key: string
	name: string
}

// One physical layer of the stack, top to bottom. Depths are mils below the board's top surface.
export interface StackLayer {
	kind: "mask" | "copper" | "dielectric"
	key: string // copper: the scene's layer key (TOP, MID-LAYER3, BOTTOM); mask: TOPSOLDER / BOTTOMSOLDER
	name: string
	top: number
	bottom: number
	core: boolean // dielectric: a core (else prepreg)
}

export interface Board3d {
	thickness: number // mils, copper + dielectrics + masks of the layer stack
	stack: StackLayer[]
	colors: Board3dColors
	bodies: Board3dBody[]
	models: Board3dModel[]
}

const mils = (value: unknown) => Number.parseFloat(String(value ?? "0")) || 0
const NO_INDEX = 65535

// Light defaults (white mask, cream core) when a board carries no 3D configuration.
const DEFAULT_COLORS: Board3dColors = {
	background: [0.8, 0.8, 0.8],
	core: [1, 0.949, 0.8],
	coreOpacity: 0.85,
	prepreg: [0, 0, 0],
	prepregOpacity: 0.5,
	topMask: [0.953, 0.953, 0.953],
	topMaskOpacity: 0.9,
	bottomMask: [0.953, 0.953, 0.953],
	bottomMaskOpacity: 0.8,
	copper: [0.875, 0.788, 0.318],
	topSilk: [0, 0, 0],
	bottomSilk: [0, 0, 0],
}

// Windows COLORREF (0x00BBGGRR) -> rgb.
export function colorRef(value: string | undefined): Rgb | null {
	const n = Number(value)
	if (value === undefined || !Number.isFinite(n)) return null
	return [(n & 0xff) / 255, ((n >> 8) & 0xff) / 255, ((n >> 16) & 0xff) / 255]
}

export function parse3dConfig(config: string | undefined): Board3dColors {
	const fields = new Map<string, string>()
	for (const part of (config ?? "").split("`")) {
		const eq = part.indexOf("=")
		if (eq > 0) fields.set(part.slice(0, eq).toUpperCase(), decodeURIComponent(part.slice(eq + 1)))
	}
	const color = (key: string, fallback: Rgb) => colorRef(fields.get(`CFG3D.${key}`)) ?? fallback
	const opacity = (key: string, fallback: number) => {
		const n = Number.parseFloat(fields.get(`CFG3D.${key}OPACITY`) ?? "")
		return Number.isFinite(n) ? n : fallback
	}
	const d = DEFAULT_COLORS
	return {
		background: color("WORKSPACEENDCOLOR", d.background),
		core: color("BOARDCORECOLOR", d.core),
		coreOpacity: opacity("BOARDCORECOLOR", d.coreOpacity),
		prepreg: color("BOARDPREPREGCOLOR", d.prepreg),
		prepregOpacity: opacity("BOARDPREPREGCOLOR", d.prepregOpacity),
		topMask: color("TOPSOLDERMASKCOLOR", d.topMask),
		topMaskOpacity: opacity("TOPSOLDERMASKCOLOR", d.topMaskOpacity),
		bottomMask: color("BOTSOLDERMASKCOLOR", d.bottomMask),
		bottomMaskOpacity: opacity("BOTSOLDERMASKCOLOR", d.bottomMaskOpacity),
		copper: color("COPPERCOLOR", d.copper),
		topSilk: color("TOPSILKSCREENCOLOR", d.topSilk),
		bottomSilk: color("BOTSILKSCREENCOLOR", d.bottomSilk),
	}
}

// Total thickness of the board's layer stack (V9 stack, else the V7 fields).
export function stackThickness(boardItems: { key: string; value: string }[]): number {
	const field = (k: string) => boardItems.find(i => i.key.toUpperCase() === k)?.value
	let total = 0
	for (let k = 0; ; k++) {
		if (field(`V9_STACK_LAYER${k}_LAYERID`) === undefined) break
		const copper = Number.parseFloat(field(`V9_STACK_LAYER${k}_COPTHICK`) ?? "NaN")
		total += Number.isFinite(copper) ? copper : mils(field(`V9_STACK_LAYER${k}_DIELHEIGHT`))
	}
	return total > 0 ? total : 62.99 // 1.6 mm
}

// Altium V9 layer ids -> the scene's copper layer keys.
export function copperKeyOfId(id: number): string | null {
	if (id === 16777217) return "TOP"
	if (id === 16842751) return "BOTTOM"
	if (id > 16777217 && id < 16777217 + 31) return `MID-LAYER${id - 16777217}`
	if (id > 16842751 && id < 16842751 + 17) return `PLANE${id - 16842751}`
	return null
}

// The physical stack from the V9 records (masks, copper, dielectrics; overlays and paste have no
// thickness). A board without one gets a 1.6 mm two-layer stack.
export function stackLayers(boardItems: { key: string; value: string }[]): StackLayer[] {
	const field = (k: string) => boardItems.find(i => i.key.toUpperCase() === k)?.value
	const out: StackLayer[] = []
	let z = 0
	for (let k = 0; ; k++) {
		const idText = field(`V9_STACK_LAYER${k}_LAYERID`)
		if (idText === undefined) break
		const id = Number(idText)
		const name = field(`V9_STACK_LAYER${k}_NAME`) ?? ""
		const copperKey = copperKeyOfId(id)
		const copper = Number.parseFloat(field(`V9_STACK_LAYER${k}_COPTHICK`) ?? "NaN")
		const dielectric = mils(field(`V9_STACK_LAYER${k}_DIELHEIGHT`))
		if (copperKey) {
			const t = Number.isFinite(copper) ? copper : 1.4
			out.push({ kind: "copper", key: copperKey, name, top: z, bottom: z + t, core: false })
			z += t
		} else if (id === 16973834 || id === 16973835) {
			out.push({ kind: "mask", key: id === 16973834 ? "TOPSOLDER" : "BOTTOMSOLDER", name, top: z, bottom: z + dielectric, core: false })
			z += dielectric
		} else if (dielectric > 0) {
			out.push({ kind: "dielectric", key: `DIELECTRIC${k}`, name, top: z, bottom: z + dielectric, core: field(`V9_STACK_LAYER${k}_DIELTYPE`) !== "2" })
			z += dielectric
		}
	}
	if (out.some(l => l.kind === "copper")) return out
	return [
		{ kind: "mask", key: "TOPSOLDER", name: "Top Solder", top: 0, bottom: 0.4, core: false },
		{ kind: "copper", key: "TOP", name: "Top Layer", top: 0.4, bottom: 1.8, core: false },
		{ kind: "dielectric", key: "DIELECTRIC", name: "Dielectric", top: 1.8, bottom: 61.2, core: true },
		{ kind: "copper", key: "BOTTOM", name: "Bottom Layer", top: 61.2, bottom: 62.6, core: false },
		{ kind: "mask", key: "BOTTOMSOLDER", name: "Bottom Solder", top: 62.6, bottom: 63, core: false },
	]
}

export function extractBoard3d(doc: AltiumBinaryPcbDoc): Board3d {
	const d = doc as AltiumBinaryPcbDoc & Record<string, any>
	const boardItems = (d.board?.items as { key: string; value: string }[] | undefined) ?? []
	const boardField = (key: string) => boardItems.find(i => i.key.toUpperCase() === key)?.value
	const models = new Map<string, Board3dModel>()
	const bodies: Board3dBody[] = []
	for (const b of d.componentBodies as any[]) {
		const get = (k: string): string | undefined => b.items.find((i: any) => i.key === k)?.value
		const contour = bodyContour(b)
		if (contour.length === 0) continue
		const componentIndex = Number(get("COMPONENT"))
		const component = Number.isInteger(componentIndex) && componentIndex !== NO_INDEX && componentIndex < d.components.length ? componentIndex : null
		const owner = component !== null ? (d.components as any[])[component] : null
		// Bodies live on mechanical layers; the side is the owning component's (or the body's own
		// layer pairing, for free bodies, which Altium puts on the top unless told otherwise).
		const side: "top" | "bottom" = owner?.get?.("LAYER") === "BOTTOM" || /BOTTOM/.test(get("LAYER") ?? "") ? "bottom" : "top"
		let model: string | null = null
		if (get("MODEL.MODELTYPE") === "1") {
			const embedded = d.getEmbeddedModelForComponentBody(b)
			if (embedded) {
				const key = String(embedded.index)
				model = key
				if (!models.has(key)) models.set(key, { key, name: get("MODEL.NAME") ?? (embedded.record as any)?.items?.find((i: any) => i.key === "NAME")?.value ?? "" })
			}
		}
		bodies.push({
			component,
			side,
			contour,
			standoff: mils(get("STANDOFFHEIGHT")),
			height: mils(get("OVERALLHEIGHT")),
			color: colorRef(get("BODYCOLOR3D")) ?? [0.5, 0.5, 0.5],
			opacity: Number.parseFloat(get("BODYOPACITY3D") ?? "1") || 1,
			model,
			x: mils(get("MODEL.2D.X")),
			y: mils(get("MODEL.2D.Y")),
			rx: Number.parseFloat(get("MODEL.3D.ROTX") ?? "0") || 0,
			ry: Number.parseFloat(get("MODEL.3D.ROTY") ?? "0") || 0,
			rz: Number.parseFloat(get("MODEL.3D.ROTZ") ?? "0") || 0,
			dz: mils(get("MODEL.3D.DZ")),
		})
	}
	const stack = stackLayers(boardItems)
	return { thickness: stack[stack.length - 1]!.bottom, stack, colors: parse3dConfig(boardField("3DCONFIGURATION")), bodies, models: [...models.values()] }
}

// The embedded STEP file of a model key from extractBoard3d.
export async function stepBytes(doc: AltiumBinaryPcbDoc, key: string): Promise<Uint8Array | null> {
	const model = doc.embeddedModels[Number(key)]
	return model ? model.getDecompressedBytes() : null
}

// A body's outline: its vertex list (straight edges and arcs) as rings of x,y.
function bodyContour(b: any): number[][] {
	const get = (k: string): string | undefined => b.items.find((i: any) => i.key === k)?.value
	const ring: number[] = []
	for (let k = 0; ; k++) {
		const vx = get(`VX${k}`)
		if (vx === undefined) break
		const x = mils(vx), y = mils(get(`VY${k}`))
		ring.push(x, y)
		if (get(`KIND${k}`) === "1") {
			// Arc from this vertex around (CX, CY) to the next vertex.
			const cx = mils(get(`CX${k}`)), cy = mils(get(`CY${k}`)), r = mils(get(`R${k}`))
			// Altium arcs run CCW from SA to EA, starting at this vertex.
			const sa = Number(get(`SA${k}`)) || 0, ea = Number(get(`EA${k}`)) || 0
			let sweep = (((ea - sa) % 360) + 360) % 360
			if (sweep < 1e-3) sweep = 360
			const a0 = Math.atan2(y - cy, x - cx)
			const a1 = a0 + (sweep * Math.PI) / 180
			const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 12)))
			for (let s = 1; s < steps; s++) {
				const a = a0 + ((a1 - a0) * s) / steps
				ring.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
			}
		}
	}
	// The vertex list closes on itself; drop the repeated first point.
	if (ring.length >= 4 && Math.abs(ring[0]! - ring[ring.length - 2]!) < 1e-6 && Math.abs(ring[1]! - ring[ring.length - 1]!) < 1e-6) ring.length -= 2
	return ring.length >= 6 ? [ring] : []
}
