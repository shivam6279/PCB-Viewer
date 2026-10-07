// A footprint as an SVG picture: the library footprint a part was placed from, the same for every
// part that uses it. Drawn from one placement of it on the board (one at 0° on the top side when
// there is one), turned back to 0° about the part's origin and, for a bottom-side placement,
// un-mirrored, with every layer drawn as its top-side counterpart: the footprint as designed. Pads
// (copper, Multi-Layer) and silkscreen in the board's layer colours, the courtyard and component
// centre (origin) layers in grey, holes on top; no text, mask or paste.
import { LAYER_ALPHA, PAD_HOLE, VIA_HOLE } from "./draw"
import { drawOrder, type PcbLayer } from "./layers"
import type { PcbScene, PcbSceneComponent, Prim } from "./scene"

const n = (v: number) => Number(v.toFixed(3))
const GREY_LAYERS = /courtyard|component center|origin/i

// Layer colours greyed (kept light enough to read on black).
function grey(hex: string): string {
	const v = Number.parseInt(hex.slice(1), 16)
	const lum = (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255
	const g = Math.round(255 * (0.45 + 0.4 * lum))
	return `rgb(${g},${g},${g})`
}

// The top-side counterpart of a layer: Bottom Layer -> Top Layer, Bottom Overlay -> Top Overlay,
// "Bottom Courtyard" -> "Top Courtyard"...
function topSide(layer: PcbLayer, layers: PcbLayer[]): PcbLayer {
	const byKey: Record<string, string> = { BOTTOM: "TOP", BOTTOMOVERLAY: "TOPOVERLAY", BOTTOMSOLDER: "TOPSOLDER", BOTTOMPASTE: "TOPPASTE" }
	const key = byKey[layer.key]
	if (key) return layers.find(l => l.key === key) ?? layer
	if (/^bottom\b/i.test(layer.name)) {
		const name = layer.name.replace(/^bottom/i, "Top").toLowerCase()
		return layers.find(l => l.name.toLowerCase() === name) ?? layer
	}
	return layer
}

// The placement drawn for a footprint: one at 0° on the top side, else any on the top, else the first.
function representative(scene: PcbScene, footprint: string): PcbSceneComponent | undefined {
	const all = scene.components.filter(c => c.footprint === footprint)
	const turn = (c: PcbSceneComponent) => ((c.rotation % 360) + 360) % 360
	return all.find(c => c.side === "top" && turn(c) < 1e-6) ?? all.find(c => c.side === "top") ?? all[0]
}

const pictures = new WeakMap<PcbScene, Map<string, string | null>>()

// The picture of a part's footprint (the same markup for every part with that footprint).
export function footprintSvg(scene: PcbScene, componentIndex: number): string | null {
	const footprint = scene.components[componentIndex]?.footprint
	if (footprint === undefined) return null
	let cache = pictures.get(scene)
	if (!cache) pictures.set(scene, (cache = new Map()))
	if (!cache.has(footprint)) {
		const c = representative(scene, footprint) ?? scene.components[componentIndex]!
		cache.set(footprint, drawFootprint(scene, c))
	}
	return cache.get(footprint)!
}

function drawFootprint(scene: PcbScene, c: PcbSceneComponent): string | null {
	const bottom = c.side === "bottom"
	const a = (c.rotation * Math.PI) / 180
	const cos = Math.cos(a), sin = Math.sin(a)
	// Board point -> picture point: to the part's origin, turned back, un-mirrored (bottom), y down.
	const at = (x: number, y: number): [number, number] => {
		const dx = x - c.x, dy = y - c.y
		const u = dx * cos + dy * sin, v = -dx * sin + dy * cos
		return [bottom ? -u : u, -v]
	}
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
	const grow = ([x, y]: [number, number], r = 0) => {
		x0 = Math.min(x0, x - r)
		y0 = Math.min(y0, y - r)
		x1 = Math.max(x1, x + r)
		y1 = Math.max(y1, y + r)
	}
	// An arc's direction in the picture: counter-clockwise on the board, turned back (and mirrored
	// for the bottom, which reverses it); in y-down picture space counter-clockwise is sweep-flag 0.
	const arc = (p: Extract<Prim, { t: "arc" }>) => {
		const sweep = ((((p.a1 - p.a0) % 360) + 360) % 360) || 360
		let start = p.a0 - c.rotation
		if (bottom) start = 180 - (start + sweep)
		const [cx, cy] = at(p.x, p.y)
		const point = (deg: number): [number, number] => [cx + p.r * Math.cos((deg * Math.PI) / 180), cy - p.r * Math.sin((deg * Math.PI) / 180)]
		const steps = Math.max(2, Math.ceil(sweep / 10))
		for (let k = 0; k <= steps; k++) grow(point(start + (sweep * k) / steps), p.w / 2)
		const r = n(p.r)
		const [ax, ay] = point(start)
		if (sweep >= 360) {
			const [bx, by] = point(start + 180)
			return `M ${n(ax)} ${n(ay)} A ${r} ${r} 0 1 0 ${n(bx)} ${n(by)} A ${r} ${r} 0 1 0 ${n(ax)} ${n(ay)}`
		}
		const [bx, by] = point(start + sweep)
		return `M ${n(ax)} ${n(ay)} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 0 ${n(bx)} ${n(by)}`
	}
	const shape = (p: Prim, color: string): string => {
		switch (p.t) {
			case "seg": {
				const s = at(p.x1, p.y1), e = at(p.x2, p.y2)
				grow(s, p.w / 2)
				grow(e, p.w / 2)
				return `<path d="M ${n(s[0])} ${n(s[1])} L ${n(e[0])} ${n(e[1])}" stroke="${color}" stroke-width="${n(p.w)}" stroke-linecap="round" fill="none"/>`
			}
			case "arc":
				return `<path d="${arc(p)}" stroke="${color}" stroke-width="${n(p.w)}" stroke-linecap="round" fill="none"/>`
			case "circle": {
				const m = at(p.x, p.y)
				grow(m, p.r)
				return `<circle cx="${n(m[0])}" cy="${n(m[1])}" r="${n(p.r)}" fill="${color}"/>`
			}
			case "poly": {
				const d = p.rings.map(ring => {
					const pts: string[] = []
					for (let k = 0; k + 1 < ring.length; k += 2) {
						const q = at(ring[k]!, ring[k + 1]!)
						grow(q)
						pts.push(`${n(q[0])} ${n(q[1])}`)
					}
					return `M ${pts.join(" L ")} Z`
				})
				return `<path d="${d.join(" ")}" fill="${color}" fill-rule="evenodd"/>`
			}
			default:
				return ""
		}
	}

	const objects = c.objects.map(id => scene.objects[id]!).filter(o => o.kind !== "text")
	const layerOf = new Map(scene.layers.map(l => [l.key, l]))
	// Each object on its layer's top-side counterpart; only pads, silkscreen, courtyard and origin.
	const drawnOn = (key: string): { layer: PcbLayer; greyed: boolean } | null => {
		const own = layerOf.get(key)
		if (!own) return null
		const layer = bottom ? topSide(own, scene.layers) : own
		if (layer.group === "copper" || layer.group === "silk" || layer.key === "MULTILAYER") return { layer, greyed: false }
		if (layer.group === "mech" && GREY_LAYERS.test(layer.name) && !/^bottom\b/i.test(layer.name)) return { layer, greyed: true }
		return null
	}
	const groups = new Map<string, string[]>()
	for (const o of objects) {
		const on = drawnOn(o.layer)
		if (!on) continue
		const color = on.greyed ? grey(on.layer.color) : on.layer.color
		const list = groups.get(on.layer.key) ?? groups.set(on.layer.key, []).get(on.layer.key)!
		for (const p of o.prims) list.push(shape(p, color))
	}
	const body: string[] = []
	// Greyed layers underneath, then the top-side drawing order.
	const greyKeys = [...groups.keys()].filter(k => layerOf.get(k)?.group === "mech")
	for (const key of [...greyKeys, ...drawOrder(scene.layers, "", "top").filter(k => !greyKeys.includes(k))]) {
		const shapes = groups.get(key)
		if (shapes?.length) body.push(`<g data-layer="${key}" opacity="${LAYER_ALPHA}">${shapes.join("")}</g>`)
	}
	const holes = objects.flatMap(o => o.holes.map(h => shape(h, o.kind === "via" ? VIA_HOLE : PAD_HOLE)))
	if (holes.length) body.push(`<g data-layer="holes" opacity="${LAYER_ALPHA}">${holes.join("")}</g>`)
	if (body.length === 0 || !Number.isFinite(x0)) return null
	const pad = Math.max(x1 - x0, y1 - y0) * 0.12
	const viewBox = [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad].map(n).join(" ")
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet"><g>${body.join("")}</g></svg>`
}
