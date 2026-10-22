// The schematic as a PDF: a page per sheet instance in hierarchy order (physical), or one page per
// schematic document (logical: a sheet placed several times, by REPEAT or by several sheet symbols,
// gets one page under a note of its instances and how each renames), drawn as vectors from the view's
// own SVG. Ports, sheet entries and sheet symbols link to the other end of their connection; parts
// and nets open a menu of their details / sheets (click-menus.ts, viewers that run PDF JavaScript);
// the bookmarks follow the hierarchy. Loaded only when an export is asked for.
import { jsPDF } from "jspdf"
import { svg2pdf } from "svg2pdf.js"
import type { ProjectData } from "../../parse/project-data"
import type { Parser } from "../../parse/parser"
import type { ProjectSummary } from "../../model/load-project"
import type { ProjectSource } from "../../source/types"
import { channelOf, flattenHierarchy, type HierarchyNode } from "../../model/hierarchy"
import { stripExt } from "../../source/paths"
import { loadSheet } from "../SchematicView"
import { unionBox, type Box } from "../sheet-scene"
import { WILDCARD_COLOR, writeDesignators, writeNetColors, writeNetNames, writeWildcardNames } from "../sheet-text"
import { sheetLinks } from "./links"
import { prepareSvgForPdf, toCp1252 } from "./svg-for-pdf"
import { embedLocalFonts, pdfStyle, type Embedded, type LocalFont, type PdfStyle } from "./local-fonts"
import { channelNote, namesPerInstance, WILDCARD, type ChannelNote } from "./channel-note"
import type { SchPdfOptions } from "./options"
import { addFitDests, menuScript, patchMenuLinks, placeholder, type SheetSpot } from "./click-menus"
import { partFacts } from "../part-facts"

const PT_PER_UNIT = 0.72 // a sheet unit is 10 mil

interface Page {
	members: HierarchyNode[] // the instances drawn: one, or every channel of a repeated sheet
	paper: Box
	top: number // pt above the sheet: the channel note's band
	boxes: Map<number, Box> // record -> drawn extent, for the records links start or end at
	parts: { i: number; box: Box }[] // each part's body (without its texts)
	netObjects: { i: number; box: Box }[] // wire runs, net labels and power ports
	nets: Map<number, Box> // each net's extent on the sheet, for every instance drawn
}

// Thin objects (a straight wire) get this much (sheet units) around them to be clickable.
const PICK_PAD = 2
const NET_KINDS = ["27", "25", "17"]
// The channel note: its text sizes and spacing, pt.
const NOTE = { title: 9, line: 8, gap: 1.35, pad: 14 }

export async function exportSchematicPdf(
	source: ProjectSource,
	project: ProjectSummary,
	parser: Parser,
	data: ProjectData,
	options: SchPdfOptions,
	fonts: LocalFont[], // this computer's fonts (queryLocalFonts), to embed the sheets' own
	onProgress: (done: number, total: number) => void,
): Promise<Blob> {
	const compiled = data.compiled
	// The pages: instances in hierarchy order; logical, every instance of one document shares the page
	// of the first.
	const groups: HierarchyNode[][] = []
	const groupOf = new Map<string, HierarchyNode[]>()
	for (const node of flattenHierarchy(project.hierarchy).filter(n => n.docPath)) {
		const key = options.channels === "grouped" ? `doc:${node.docPath!.toLowerCase()}` : `node:${node.id}`
		const group = groupOf.get(key)
		if (group) group.push(node)
		else {
			groupOf.set(key, [node])
			groups.push(groupOf.get(key)!)
		}
	}
	// A shared page shows the sheet as drawn (no channel), a page per instance shows that instance.
	const sheets = await Promise.all(groups.map(g => loadSheet(source, project, g[0]!.docPath!, g.length > 1 ? null : channelOf(project.hierarchy, g[0]!.id), parser)))
	let embedded: Embedded = new Map()
	const links = sheetLinks(project.hierarchy, compiled, data.sheets)
	const linked = new Map<string, Set<number>>() // instance -> records some link starts or ends at
	const mark = (id: string, i: number) => (linked.get(id) ?? linked.set(id, new Set()).get(id)!).add(i)
	for (const [id, list] of links)
		for (const l of list) {
			mark(id, "i" in l.from ? l.from.i : l.from.owner)
			for (const i of l.to.objects) mark(l.to.instanceId, i)
		}
	const partsOn = new Map<string, number[]>()
	for (const c of compiled.components) (partsOn.get(c.instanceId) ?? partsOn.set(c.instanceId, []).get(c.instanceId)!).push(c.i)

	// Laid out off screen: measuring the drawn records needs a live SVG.
	const host = document.createElement("div")
	host.style.cssText = "position:fixed;left:-30000px;top:0;width:1600px;height:1200px;visibility:hidden;pointer-events:none"
	document.body.appendChild(host)
	let pdf: jsPDF | null = null
	const pages: Page[] = []
	try {
		for (const [k, members] of groups.entries()) {
			const node = members[0]!
			const sheet = sheets[k]!
			host.innerHTML = sheet.markup
			const svg = host.querySelector("svg")!
			const content = svg.querySelector("[data-sheet-content]") ?? svg
			// One instance: its own names. Several (logical): what they share, * for the rest.
			let wildcards: { designators: number[]; nets: number[] } | null = null
			if (members.length === 1) {
				writeDesignators(content, compiled, node.id)
				writeNetNames(content, compiled, node.id)
			} else wildcards = writeWildcardNames(content, namesPerInstance(members, compiled))
			writeNetColors(content, options.netColors ? (data.wireColors[node.id] ?? {}) : {})

			const clip = svg.querySelector("#altium-sheet-paper rect")
			const paper = clip
				? { x: Number(clip.getAttribute("x")), y: Number(clip.getAttribute("y")), w: Number(clip.getAttribute("width")), h: Number(clip.getAttribute("height")) }
				: sheet.viewBox
			const boxOf = (i: number) => {
				const g = content.querySelector<SVGGElement>(`g[data-i="${i}"]`)
				return g ? unionBox([g]) : null
			}
			const boxes = new Map<number, Box>()
			for (const m of members)
				for (const i of linked.get(m.id) ?? []) {
					const b = boxes.has(i) ? null : boxOf(i)
					if (b) boxes.set(i, b)
				}
			const parts = (partsOn.get(node.id) ?? []).flatMap(i => {
				const own = [...content.querySelectorAll<SVGGElement>(`g[data-i="${i}"], g[data-o="${i}"]`)].filter(g => g.dataset.k !== "41" && g.dataset.k !== "34")
				const box = unionBox(own)
				return box ? [{ i, box }] : []
			})
			const netObjects: Page["netObjects"] = []
			const drawn = new Map<number, Box>() // net record -> its extent
			for (const g of content.querySelectorAll<SVGGElement>(NET_KINDS.map(k => `g[data-k="${k}"]`).join(", "))) {
				const i = Number(g.dataset.i)
				const b = unionBox([g])
				if (!b) continue
				drawn.set(i, b)
				// A wire is clickable along each straight run, not over the whole box of its bends.
				const line = g.dataset.k === "27" ? g.querySelector("polyline") : null
				const runs = line && line.points.numberOfItems >= 2 ? [...Array(line.points.numberOfItems - 1).keys()].map(s => boxesUnion([pointBox(line.points.getItem(s)), pointBox(line.points.getItem(s + 1))])!) : [b]
				for (const r of runs) netObjects.push({ i, box: { x: r.x - PICK_PAD, y: r.y - PICK_PAD, w: r.w + 2 * PICK_PAD, h: r.h + 2 * PICK_PAD } })
			}
			const nets = new Map<number, Box>()
			for (const m of members)
				for (const [i, netId] of Object.entries(compiled.netAt[m.id] ?? {})) {
					const b = drawn.get(Number(i))
					if (!b) continue
					const was = nets.get(netId)
					nets.set(netId, was ? boxesUnion([was, b])! : b)
				}

			const note = wildcards ? channelNote(node.fileName, members, compiled, wildcards) : null
			const top = note ? noteHeight(note) : 0
			pages.push({ members, paper, top, boxes, parts, netObjects, nets })

			const w = paper.w * PT_PER_UNIT
			const h = paper.h * PT_PER_UNIT + top
			const orientation = w >= h ? "landscape" : "portrait"
			if (!pdf) {
				pdf = new jsPDF({ unit: "pt", format: [w, h], orientation, compress: true })
				embedded = await embedLocalFonts(pdf, fonts, fontsUsed(sheets.map(s => s.markup)))
			} else pdf.addPage([w, h], orientation)
			if (note) drawNote(pdf, note, w, top)
			prepareSvgForPdf(svg, pdf, embedded)
			svg.setAttribute("viewBox", `${paper.x} ${paper.y} ${paper.w} ${paper.h}`)
			// svg2pdf starts from its own default font and sets a text's font only where it differs from
			// that: the font left by measuring (an italic *) would otherwise carry over to every text.
			pdf.setFont("times", "normal")
			await svg2pdf(svg, pdf, { x: 0, y: top, width: w, height: paper.h * PT_PER_UNIT })
			onProgress(pages.length, groups.length)
		}
	} finally {
		host.remove()
	}
	if (!pdf) throw new Error("The project has no sheets to export")

	const pageOf = new Map(pages.flatMap((p, k) => p.members.map(m => [m.id, k] as const)))
	const sheetLabel = (n: HierarchyNode) => `${stripExt(n.fileName)} (${n.displayDesignator})`
	// Where a box is on a page, pt from the page's top left.
	const onPage = (page: Page, b: Box) => ({ x: (b.x - page.paper.x) * PT_PER_UNIT, y: (b.y - page.paper.y) * PT_PER_UNIT + page.top, w: b.w * PT_PER_UNIT, h: b.h * PT_PER_UNIT })
	// Where a jump to a box puts the view: kept at its zoom, the box a little in from the corner.
	const viewAt = (page: Page, b: Box) => {
		const r = onPage(page, b)
		return { left: Math.max(0, r.x - 0.08 * page.paper.w * PT_PER_UNIT), top: Math.max(0, r.y - 0.08 * page.paper.h * PT_PER_UNIT) }
	}
	// Where a menu's pick puts the view: fitted to the box with room around it, at least a fifth of the
	// sheet across (one net label alone is not a view), in PDF space (up from the page's foot).
	const spotOf = (node: HierarchyNode, b: Box): SheetSpot | null => {
		const k = pageOf.get(node.id)
		if (k === undefined) return null
		const page = pages[k]!
		const r = onPage(page, b)
		const pageW = page.paper.w * PT_PER_UNIT
		const pageH = page.paper.h * PT_PER_UNIT + page.top
		const w = Math.min(pageW, Math.max(r.w * 1.3, pageW / 5))
		const h = Math.min(pageH, Math.max(r.h * 1.3, pageH / 5))
		const left = Math.min(Math.max(0, r.x + r.w / 2 - w / 2), pageW - w)
		const top = Math.min(Math.max(0, r.y + r.h / 2 - h / 2), pageH - h)
		return { label: sheetLabel(node), page: k + 1, rect: [left, pageH - top - h, left + w, pageH - top] }
	}
	const nodeById = new Map(pages.flatMap(p => p.members.map(m => [m.id, m] as const)))
	// The menus: a part's or a net's link calls its menu by its place in these lists.
	const parts = compiled.components
	const nets = compiled.nets.map(net => ({
		net,
		spots: net.occurrences.flatMap(o => {
			const node = nodeById.get(o.instanceId)
			const box = node && pages[pageOf.get(node.id)!]!.nets.get(net.id)
			const spot = node && box ? spotOf(node, box) : null
			return spot ? [spot] : []
		}),
	}))
	const partMenu = new Map(parts.map((c, k) => [c.id, k]))

	pages.forEach((page, k) => {
		pdf!.setPage(k + 1)
		// A shared page's parts and nets are its first channel's.
		const node = page.members[0]!
		const netAt = compiled.netAt[node.id] ?? {}
		// Parts, then nets over them, then ports and symbols on top (a later link wins where they overlap).
		for (const part of page.parts) {
			const menu = partMenu.get(`${node.id}#${part.i}`)
			const r = onPage(page, part.box)
			if (menu !== undefined) pdf!.link(r.x, r.y, r.w, r.h, { url: placeholder("p", menu) })
		}
		for (const o of page.netObjects) {
			const netId = netAt[o.i]
			const r = onPage(page, o.box)
			if (netId !== undefined) pdf!.link(r.x, r.y, r.w, r.h, { url: placeholder("n", netId) })
		}
		for (const link of links.get(node.id) ?? []) {
			const from = page.boxes.get("i" in link.from ? link.from.i : link.from.owner)
			const target = pageOf.get(link.to.instanceId)
			if (!from || target === undefined || target === k) continue
			const r = onPage(page, from)
			const dest = pages[target]!
			const objects = boxesUnion(link.to.objects.map(i => dest.boxes.get(i)).filter((b): b is Box => b !== undefined))
			if (objects) pdf!.link(r.x, r.y, r.w, r.h, { pageNumber: target + 1, magFactor: "XYZ", ...viewAt(dest, objects), zoom: 0 })
			else pdf!.link(r.x, r.y, r.w, r.h, { pageNumber: target + 1, magFactor: "Fit" })
		}
	})

	// Bookmarks: the sheet hierarchy (channels sharing a page each point at it).
	const bookmark = (node: HierarchyNode, parent: unknown) => {
		const k = pageOf.get(node.id)
		const item = k === undefined ? parent : pdf!.outline.add(parent as never, sheetLabel(node), { pageNumber: k + 1 })
		for (const c of node.children) bookmark(c, item)
	}
	for (const root of project.hierarchy) bookmark(root, null)

	pdf.setProperties({ title: project.name, creator: "PCB-Viewer" })
	pdf.addJS(
		menuScript(
			parts.map(c => {
				const { key, other, links } = partFacts(c)
				return {
					title: c.comment ? `${c.designator}   ${c.comment}` : c.designator,
					key: [...(c.description && c.description !== c.comment ? [`Description: ${c.description}`] : []), ...key.map(f => `${f.label}: ${f.value}`)],
					more: other.map(p => `${p.name}: ${p.value.trim()}`),
					links: links.map(l => `${l.text}: ${l.url}`),
				}
			}),
			nets.map(({ net, spots }) => ({ title: net.physicalName.replaceAll("\\", ""), sheets: spots.map((s, k) => ({ label: s.label, dest: `pcbv_n${net.id}_${k}` })) })),
		),
	)
	addFitDests(
		pdf,
		nets.flatMap(({ net, spots }) => spots.map((s, k) => ({ name: `pcbv_n${net.id}_${k}`, page: s.page, rect: s.rect }))),
	)
	const file = patchMenuLinks(pdf.output())
	const bytes = new Uint8Array(file.length)
	for (let i = 0; i < file.length; i++) bytes[i] = file.charCodeAt(i)
	return new Blob([bytes], { type: "application/pdf" })
}

function noteHeight(note: ChannelNote): number {
	return NOTE.pad * 2 + NOTE.title * NOTE.gap + note.channels.length * NOTE.line * NOTE.gap
}

// The channel note in the band above a shared sheet: a line per channel in columns (channel,
// designators, net labels, an example).
function drawNote(pdf: jsPDF, note: ChannelNote, width: number, height: number) {
	const x = NOTE.pad * 2
	pdf.setFillColor("#f3f4f6")
	pdf.rect(0, 0, width, height, "F")
	pdf.setTextColor("#111111")
	pdf.setFont("helvetica", "bold")
	pdf.setFontSize(NOTE.title)
	let y = NOTE.pad + NOTE.title
	// The title, with its * as drawn on the sheet.
	const [before, after] = toCp1252(note.title).split(WILDCARD) as [string, string]
	pdf.text(before, x, y)
	const starAt = x + pdf.getTextWidth(before)
	pdf.setFont("helvetica", "bolditalic")
	pdf.setTextColor(WILDCARD_COLOR)
	pdf.text(WILDCARD, starAt, y)
	const afterAt = starAt + pdf.getTextWidth(WILDCARD) + 1
	pdf.setFont("helvetica", "bold")
	pdf.setTextColor("#111111")
	pdf.text(after ?? "", afterAt, y)
	pdf.setFontSize(NOTE.line)
	// Columns: instance, then "Designators: * = 0" and "Net labels: * = 0" (only where something varies).
	const cell = (label: string, value: string) => (value ? [`${label}: `, WILDCARD, ` = ${value}`] : [])
	const width3 = (parts: string[]) => {
		let w = 0
		parts.forEach((t, k) => {
			pdf.setFont("helvetica", k === 1 ? "italic" : "normal")
			w += pdf.getTextWidth(toCp1252(t))
		})
		return w
	}
	pdf.setFont("helvetica", "bold")
	const name = Math.max(...note.channels.map(c => pdf.getTextWidth(toCp1252(c.name)))) + 16
	const designators = Math.max(0, ...note.channels.map(c => width3(cell("Designators", c.designators)))) + 24
	for (const c of note.channels) {
		y += NOTE.line * NOTE.gap
		pdf.setFont("helvetica", "bold")
		pdf.setTextColor("#111111")
		pdf.text(toCp1252(c.name), x, y)
		for (const [at, parts] of [[x + name, cell("Designators", c.designators)], [x + name + designators, cell("Net labels", c.nets)]] as const) {
			let cx = at
			parts.forEach((t, k) => {
				pdf.setFont("helvetica", k === 1 ? "italic" : "normal")
				pdf.setTextColor(k === 1 ? WILDCARD_COLOR : "#111111")
				pdf.text(toCp1252(t), cx, y)
				cx += pdf.getTextWidth(toCp1252(t))
			})
		}
	}
	pdf.setTextColor("#000000")
}

// The font families the sheets draw text in (lower case), with the styles of each.
function fontsUsed(markups: string[]): Map<string, Set<PdfStyle>> {
	const out = new Map<string, Set<PdfStyle>>()
	for (const markup of markups)
		for (const [tag] of markup.matchAll(/<text\b[^>]*>/g)) {
			const family = /\sfont-family="([^"]*)"/.exec(tag)?.[1]?.replaceAll(/&quot;|["']/g, "").trim().toLowerCase()
			if (!family) continue
			const style = pdfStyle(/\sfont-weight="([^"]*)"/.exec(tag)?.[1] ?? null, /\sfont-style="([^"]*)"/.exec(tag)?.[1] ?? null)
			;(out.get(family) ?? out.set(family, new Set()).get(family)!).add(style)
		}
	// A logical page's * is italic in whatever font its name is in.
	for (const styles of out.values()) styles.add("italic")
	return out
}

const pointBox = (p: DOMPoint): Box => ({ x: p.x, y: p.y, w: 0, h: 0 })

function boxesUnion(boxes: Box[]): Box | null {
	if (boxes.length === 0) return null
	const x = Math.min(...boxes.map(b => b.x))
	const y = Math.min(...boxes.map(b => b.y))
	return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y }
}
