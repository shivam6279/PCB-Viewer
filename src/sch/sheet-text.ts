// Texts a sheet drawing shows per instance, written into the rendered SVG: shared by the schematic
// view and the PDF export.
import type { CompiledProject } from "../model/compile"
import { renderAltiumNegatedText } from "./render/render-altium-negated-text"
import { escapeXml } from "./render/svg-utils"
import { WILDCARD, wildcard } from "./pdf/channel-note"

// Physical designators: one drawing serves every channel of a sheet, and its designators are the
// sheet's own (TVS1); this instance's parts are named as compiled (TVS1_CAN1, the board's).
export function writeDesignators(content: Element, compiled: CompiledProject, instanceId: string) {
	const designators = new Map(compiled.components.filter(c => c.instanceId === instanceId).map(c => [String(c.i), c.designator]))
	for (const g of content.querySelectorAll<SVGGElement>('g[data-k="34"][data-o]')) {
		const designator = designators.get(g.getAttribute("data-o")!)
		const text = g.querySelector("text")
		if (designator && text) text.textContent = designator
	}
}

// Net colour bands under the wires, from the compiled nets (wire record -> colour): the renderer's own
// only know the names on this sheet. Replaces the drawn ones; none at all with no colours.
export function writeNetColors(content: Element, colors: Record<number, string>) {
	for (const el of [...content.querySelectorAll("[data-net-color]")]) el.remove()
	const bands = document.createDocumentFragment()
	const byIndex = new Map([...content.querySelectorAll("g[data-i]")].map(g => [g.getAttribute("data-i"), g]))
	for (const [i, color] of Object.entries(colors)) {
		const g = byIndex.get(i)
		for (const line of g?.querySelectorAll("polyline:not(.hit)") ?? []) {
			const band = line.cloneNode(false) as SVGElement
			band.removeAttribute("data-record")
			band.setAttribute("data-net-color", "")
			band.setAttribute("stroke", color)
			band.setAttribute("stroke-width", "5.1")
			bands.appendChild(band)
		}
	}
	content.insertBefore(bands, content.firstChild)
}

// The colour and style of the part a logical page's names leave to each instance (*).
export const WILDCARD_COLOR = "#c2410c"

// A logical page (one drawing for several instances): each designator and net label written with what
// its instances share and a wildcard, styled apart, for the rest (R1_CAN0, R1_CAN1 -> R1_CAN*). Returns
// the records written so, for the page's note.
export function writeWildcardNames(content: Element, names: { designators: Map<number, string[]>; nets: Map<number, string[]> }): { designators: number[]; nets: number[] } {
	const star = `<tspan class="pcbv-wildcard" font-style="italic" fill="${WILDCARD_COLOR}">${WILDCARD}</tspan>`
	const write = (text: Element, list: string[] | undefined, render: (s: string) => string) => {
		if (!list || list.some(n => !n)) return false
		const w = wildcard(list)
		if (!w) text.innerHTML = render(list[0]!)
		else text.innerHTML = `${render(w.prefix)}${star}${render(w.suffix)}`
		return w !== null
	}
	const written = { designators: [] as number[], nets: [] as number[] }
	for (const g of content.querySelectorAll<SVGGElement>('g[data-k="34"][data-o]')) {
		const o = Number(g.getAttribute("data-o"))
		const text = g.querySelector("text")
		if (text && write(text, names.designators.get(o), escapeXml)) written.designators.push(o)
	}
	for (const g of content.querySelectorAll<SVGGElement>('g[data-k="25"], g[data-k="17"]')) {
		const i = Number(g.getAttribute("data-i"))
		const text = g.querySelector("text")
		if (text && write(text, names.nets.get(i), renderAltiumNegatedText)) written.nets.push(i)
	}
	return written
}

// Net labels and power ports name the net by its physical name (the one written on this sheet, if
// different, is the view's hover tooltip).
export function writeNetNames(content: Element, compiled: CompiledProject, instanceId: string) {
	const netAt = compiled.netAt[instanceId] ?? {}
	for (const g of content.querySelectorAll<SVGGElement>('g[data-k="25"], g[data-k="17"]')) {
		const text = g.querySelector("text")
		const net = compiled.nets[netAt[Number(g.getAttribute("data-i"))] ?? -1]
		if (!text) continue
		if (g.dataset.drawn === undefined) {
			g.dataset.drawn = text.innerHTML
			g.dataset.name = text.textContent ?? ""
		}
		const renamed = net && g.dataset.name!.toUpperCase() !== net.physicalName.replaceAll("\\", "").toUpperCase()
		text.innerHTML = renamed ? renderAltiumNegatedText(net.physicalName) : g.dataset.drawn
	}
}
