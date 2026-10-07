// The bill of materials: the design's parts grouped into lines, from the best source the project has.
// Parts come from the board when there is one (what is actually built), else from the compiled
// schematics. A BOM document (.BomDoc) holds no designators or quantities, only a catalog of the
// project's library items with the manufacturer / supplier parts chosen for them: when the project
// has one, each line takes its item's description and part choices from it.
import type { CompiledProject } from "../model/compile"
import type { Parameter } from "../model/schematic-data"
import type { PcbComponent } from "../parse/extract-pcb"

// What a designator points at, for selecting it: the compiled component, else the board's.
export type BomRef = { kind: "component"; id: string } | { kind: "pcbComponent"; index: number }

export interface BomPart {
	unit: string // one physical part: a multi-part symbol's records share it
	designator: string
	comment: string
	description: string
	footprint: string
	libraryItem?: string
	kind: number
	parameters: Parameter[]
	ref: BomRef
}

export interface BomChoice {
	manufacturer: string
	mpn: string
	supplier: string
	supplierPartNo: string
}

export interface BomDocItem {
	uniqueId: string // "<library>[/<table>]\<item>"
	designItemId: string
	description: string
	comment: string // "=Value" style references are left as written
	lineNumber: string
	choices: BomChoice[]
}

export interface BomLine {
	line: number
	designators: { name: string; ref: BomRef }[]
	quantity: number
	comment: string
	description: string
	footprint: string
	manufacturer: string
	mpn: string
	supplier: string
	supplierPartNo: string
	fromBomDoc: boolean // the line's item was found in the BOM document
}

export interface Bom {
	source: "board" | "schematic"
	bomDoc: string | null // the BOM document's file name, when the project has one
	lines: BomLine[]
	parts: number
}

// Component kinds left out of a BOM: graphical, net tie (no BOM), standard (no BOM).
const NOT_IN_BOM = new Set([2, 4, 5])

// --- the BOM document --------------------------------------------------------------------------

function fields(line: string): Map<string, string> {
	const out = new Map<string, string>()
	for (const part of line.split("|")) {
		const eq = part.indexOf("=")
		if (eq > 0) out.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1))
	}
	return out
}

// The catalog of a .BomDoc: one item per CatalogItem record, with the PartChoice records after it.
export function parseBomDoc(text: string): BomDocItem[] {
	const items: BomDocItem[] = []
	let current: BomDocItem | null = null
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("|RECORD=")) continue
		const f = fields(line)
		const record = f.get("RECORD")
		if (record === "CatalogItem") {
			current = {
				uniqueId: f.get("UNIQUEID") ?? "",
				designItemId: f.get("DESIGNITEMID") ?? "",
				description: f.get("DESCRIPTION") ?? "",
				comment: f.get("USERCOMMENTS") ?? "",
				lineNumber: f.get("LINENUMBER") ?? "",
				choices: [],
			}
			items.push(current)
		} else if (record === "PartChoice" && current) {
			current.choices.push({
				manufacturer: f.get("MANUFACTURER") ?? "",
				mpn: f.get("MANUFACTURERPARTNO") ?? "",
				supplier: f.get("SUPPLIER") ?? "",
				supplierPartNo: f.get("SUPPLIERPARTNO") ?? "",
			})
		} else if (record === "PartChoiceGroups") current = null
	}
	return items
}

// --- the parts -----------------------------------------------------------------------------------

// A comment written as a parameter reference ("=Value") reads as that parameter, when the part has it.
function resolved(comment: string, parameters: Parameter[]): string {
	if (!comment.startsWith("=")) return comment
	const name = comment.slice(1).trim().toLowerCase()
	return parameters.find(p => p.name.toLowerCase() === name)?.value ?? comment
}

// The board's parts, named by their compiled designators (R5_ESC_2, not the board's repeated R5_ESC)
// and carrying the schematic's parameters when the schematic has the part.
export function boardParts(components: PcbComponent[], compiled: CompiledProject | null): BomPart[] {
	const byPath = new Map(compiled?.components.map(c => [c.uniquePath, c]) ?? [])
	return components.map((p, index) => {
		const c = p.sourceUniqueId ? byPath.get(p.sourceUniqueId) : undefined
		return {
			unit: `board:${index}`,
			designator: c?.designator || p.designator,
			comment: resolved(c?.comment || p.comment, c?.parameters ?? []),
			description: p.description || c?.description || "",
			footprint: p.footprint || c?.footprint || "",
			libraryItem: p.libraryItem ?? c?.libraryItem,
			kind: c?.kind ?? p.kind,
			parameters: c?.parameters ?? [],
			ref: c ? { kind: "component", id: c.id } : { kind: "pcbComponent", index },
		}
	})
}

export function schematicParts(compiled: CompiledProject): BomPart[] {
	return compiled.components.map(c => ({
		unit: `${c.instanceId}|${c.designator}`,
		designator: c.designator,
		comment: resolved(c.comment, c.parameters),
		description: c.description,
		footprint: c.footprint,
		libraryItem: c.libraryItem,
		kind: c.kind ?? 0,
		parameters: c.parameters,
		ref: { kind: "component", id: c.id },
	}))
}

// --- the lines -----------------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

const param = (part: BomPart, names: RegExp) => part.parameters.find(p => names.test(p.name.trim()))?.value ?? ""
const MANUFACTURER = /^manufacturer(?: 1)?$/i
const MPN = /^(?:manufacturer part number(?: 1)?|mpn|part number|manufacturer part no\.?)$/i
const SUPPLIER = /^supplier(?: 1)?$/i
const SUPPLIER_PN = /^supplier part number(?: 1)?$/i

export function buildBom(parts: BomPart[], source: Bom["source"], bomDoc: { name: string; items: BomDocItem[] } | null): Bom {
	// Each physical part once (a multi-part symbol is several records of one unit), only parts that
	// belong in a BOM. Two parts may share a designator (an unannotated copy of a sheet): both count.
	const seen = new Set<string>()
	const kept = parts.filter(p => {
		if (!p.designator || NOT_IN_BOM.has(p.kind) || seen.has(p.unit)) return false
		seen.add(p.unit)
		return true
	})

	const byId = new Map<string, BomDocItem[]>()
	const byItem = new Map<string, BomDocItem[]>()
	for (const item of bomDoc?.items ?? []) {
		const add = (map: Map<string, BomDocItem[]>, key: string) => key && (map.get(key) ?? map.set(key, []).get(key)!).push(item)
		add(byId, item.uniqueId.toLowerCase())
		add(byItem, item.designItemId.toLowerCase())
	}
	// The part's catalog item: by its library item, else by the item id alone when that is unambiguous;
	// among several (one item, different comments), the one with the part's comment.
	const itemOf = (p: BomPart): BomDocItem | null => {
		const key = p.libraryItem?.toLowerCase() ?? ""
		let candidates = byId.get(key)
		if (!candidates) {
			const item = key.slice(key.lastIndexOf("\\") + 1)
			const loose = byItem.get(item)
			if (loose && new Set(loose.map(i => i.uniqueId)).size === 1) candidates = loose
		}
		if (!candidates?.length) return null
		return candidates.find(c => c.comment === p.comment) ?? candidates[0]!
	}

	const groups = new Map<string, { item: BomDocItem | null; parts: BomPart[] }>()
	for (const p of kept) {
		const item = itemOf(p)
		const key = `${item ? item.uniqueId : (p.libraryItem ?? "")}|${p.comment}|${p.footprint}`
		const g = groups.get(key) ?? groups.set(key, { item, parts: [] }).get(key)!
		g.parts.push(p)
	}

	const drafts: (Omit<BomLine, "line"> & { lineNumber: string })[] = [...groups.values()].map(({ item, parts }) => {
		parts.sort((a, b) => collator.compare(a.designator, b.designator))
		const first = parts[0]!
		const choice = item?.choices[0]
		return {
			designators: parts.map(p => ({ name: p.designator, ref: p.ref })),
			quantity: parts.length,
			comment: first.comment,
			description: item?.description || first.description,
			footprint: first.footprint,
			manufacturer: choice?.manufacturer || param(first, MANUFACTURER),
			mpn: choice?.mpn || param(first, MPN),
			supplier: choice?.supplier || param(first, SUPPLIER),
			supplierPartNo: choice?.supplierPartNo || param(first, SUPPLIER_PN),
			fromBomDoc: item !== null,
			lineNumber: item?.lineNumber ?? "",
		}
	})
	// The BOM document's own line numbers when it gives every line one; else numbered in order of
	// their first designator.
	drafts.sort((a, b) => collator.compare(a.designators[0]!.name, b.designators[0]!.name))
	const numbered = drafts.length > 0 && drafts.every(l => /^\d+$/.test(l.lineNumber))
	if (numbered) drafts.sort((a, b) => Number(a.lineNumber) - Number(b.lineNumber))
	const lines = drafts.map(({ lineNumber, ...rest }, i) => ({ ...rest, line: numbered ? Number(lineNumber) : i + 1 }))
	return { source, bomDoc: bomDoc?.name ?? null, lines, parts: kept.length }
}

// The BOM as CSV (RFC 4180 quoting), for a spreadsheet.
export function bomCsv(bom: Bom): string {
	const cell = (v: string | number) => {
		const s = String(v)
		return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
	}
	const head = ["Line #", "Designator", "Quantity", "Comment", "Description", "Footprint", "Manufacturer", "Manufacturer Part Number", "Supplier", "Supplier Part Number"]
	const rows = bom.lines.map(l => [l.line, l.designators.map(d => d.name).join(", "), l.quantity, l.comment, l.description, l.footprint, l.manufacturer, l.mpn, l.supplier, l.supplierPartNo])
	return [head, ...rows].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n"
}
