// altiumts binary PcbDoc -> plain data for the inspectors and the net compiler: components (where they
// are), the net of every pad, and each net's routed length and copper layers.
import { AltiumBinaryPcbDoc, parseAltiumFile } from "altiumts"

export interface PcbComponent {
	designator: string
	x: number // mm from the board origin
	y: number
	rotation: number
	layer: string // "Top Layer" | "Bottom Layer"
	footprint: string
	sourceUniqueId: string
}

export interface PcbLayer {
	key: string // altiumts layer token, e.g. TOP, MID1, BOTTOM
	name: string // the board's name for it, e.g. "Signal 1"
	color: string
}

export interface PcbNet {
	name: string
	routedLength: number // mm, tracks + arcs
	layers: string[] // layer keys, in stack order
}

export interface PcbData {
	components: PcbComponent[]
	padNets: [string, string][] // ["<component source path>|<pad>", net]; designators can repeat across channels
	nets: PcbNet[]
	layers: PcbLayer[]
}

const MIL_TO_MM = 0.0254
// Altium's default copper colours (Top, Mid 1..30, Bottom).
const MID_COLORS = ["#bc8e00", "#70dbfa", "#00cc66", "#9933ff", "#00ffff", "#800080", "#ff00ff", "#808000", "#ffff00", "#808080", "#ffffff", "#800000", "#008000", "#00ff00", "#000080"]

// Inner copper layers: "MID-LAYER1" in binary boards, "MID1" in ASCII ones.
const MID_LAYER = /^MID(?:-LAYER)?(\d+)$/

const mils = (value: string | undefined) => Number.parseFloat(value ?? "0") || 0

export function parsePcb(bytes: Uint8Array): AltiumBinaryPcbDoc {
	const { document } = parseAltiumFile(bytes)
	if (!(document instanceof AltiumBinaryPcbDoc)) throw new Error("Not a PCB document")
	return document
}

export function extractPcb(source: Uint8Array | AltiumBinaryPcbDoc): PcbData {
	const document = source instanceof Uint8Array ? parsePcb(source) : source
	if (!(document instanceof AltiumBinaryPcbDoc)) throw new Error("Not a PCB document")
	const doc = document as AltiumBinaryPcbDoc & Record<string, any>
	const board = doc.board
	const field = (key: string) => (board?.items as any[] | undefined)?.find(i => i.key?.toUpperCase() === key)?.value as string | undefined
	const originX = mils(field("ORIGINX"))
	const originY = mils(field("ORIGINY"))

	const layerName = (key: string) => {
		if (key === "TOP") return field("LAYER1NAME") ?? "Top Layer"
		if (key === "BOTTOM") return field("LAYER32NAME") ?? "Bottom Layer"
		const mid = MID_LAYER.exec(key)
		return mid ? (field(`LAYER${Number(mid[1]) + 1}NAME`) ?? `Mid-Layer ${mid[1]}`) : key
	}
	const layerColor = (key: string) => {
		if (key === "TOP") return "#ff0000"
		if (key === "BOTTOM") return "#0000ff"
		const mid = MID_LAYER.exec(key)
		return mid ? (MID_COLORS[(Number(mid[1]) - 1) % MID_COLORS.length] ?? "#808080") : "#808080"
	}
	const isCopper = (key: string) => key === "TOP" || key === "BOTTOM" || MID_LAYER.test(key)
	// Listed Top, then Bottom, then the inner layers.
	const stackOrder = (key: string) => (key === "TOP" ? 0 : key === "BOTTOM" ? 1 : 1 + Number(MID_LAYER.exec(key)?.[1] ?? 500))

	const netName = (index: string | undefined) => {
		const n = index === undefined ? NaN : Number(index)
		const net = Number.isInteger(n) ? doc.nets[n] : undefined
		return (net?.items as any[] | undefined)?.find(i => i.key === "NAME")?.value as string | undefined
	}

	const components: PcbComponent[] = doc.components.map((c: any) => ({
		designator: c.designator ?? "",
		x: (mils(c.get?.("X")) - originX) * MIL_TO_MM,
		y: (mils(c.get?.("Y")) - originY) * MIL_TO_MM,
		rotation: Number.parseFloat(c.get?.("ROTATION") ?? "0") || 0,
		layer: c.get?.("LAYER") === "BOTTOM" ? layerName("BOTTOM") : layerName("TOP"),
		footprint: c.footprint ?? c.get?.("PATTERN") ?? "",
		sourceUniqueId: c.sourceUniqueId ?? "",
	}))

	const padNets: [string, string][] = []
	for (const pad of doc.pads as any[]) {
		const component = doc.components[Number(pad.get("COMPONENT"))]
		const net = netName(pad.get("NET"))
		if (component && net) padNets.push([`${component.sourceUniqueId ?? ""}|${pad.get("NAME") ?? ""}`, net])
	}

	const byNet = new Map<string, PcbNet>()
	const netEntry = (name: string) => {
		let n = byNet.get(name)
		if (!n) byNet.set(name, (n = { name, routedLength: 0, layers: [] }))
		return n
	}
	const useLayer = (net: PcbNet, layer: string | undefined) => {
		if (layer && isCopper(layer) && !net.layers.includes(layer)) net.layers.push(layer)
	}
	for (const t of doc.tracks as any[]) {
		const name = netName(t.get("NET"))
		if (!name) continue
		const net = netEntry(name)
		const length = Math.hypot(mils(t.get("X2")) - mils(t.get("X1")), mils(t.get("Y2")) - mils(t.get("Y1")))
		if (isCopper(t.get("LAYER"))) net.routedLength += length * MIL_TO_MM
		useLayer(net, t.get("LAYER"))
	}
	for (const a of doc.arcs as any[]) {
		const name = netName(a.get("NET"))
		if (!name) continue
		const net = netEntry(name)
		const sweep = ((Number(a.get("ENDANGLE")) - Number(a.get("STARTANGLE"))) % 360 + 360) % 360 || 360
		if (isCopper(a.get("LAYER"))) net.routedLength += (mils(a.get("RADIUS")) * sweep * Math.PI) / 180 * MIL_TO_MM
		useLayer(net, a.get("LAYER"))
	}
	for (const p of [...(doc.pads as any[]), ...(doc.fills as any[] ?? []), ...(doc.regions as any[] ?? [])]) {
		const name = netName(p.get?.("NET"))
		if (name) useLayer(netEntry(name), p.get("LAYER"))
	}
	for (const net of byNet.values()) net.layers.sort((a, b) => stackOrder(a) - stackOrder(b))

	const usedLayers = [...new Set([...byNet.values()].flatMap(n => n.layers))].sort((a, b) => stackOrder(a) - stackOrder(b))
	return {
		components,
		padNets,
		nets: [...byNet.values()],
		layers: usedLayers.map(key => ({ key, name: layerName(key), color: layerColor(key) })),
	}
}
