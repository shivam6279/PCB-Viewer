// altiumts SchDoc records -> plain SheetData (src/model/schematic-data.ts). Object identity `i` is
// the record's index among the document's records, the same numbering the renderer writes as data-i.
import { AltiumRecord, type AltiumSchDoc } from "altiumts"
import { getSchematicCoordinate, getSchematicIndexedPoints } from "../sch/render/altium-values"
import { resolveSchematicParameterReferenceWithContext } from "../sch/render/schematic-parameter-reference"
import { libraryItem } from "../model/library-item"
import { ADDITIONAL_BASE, type Parameter, type Pt, type SheetComponent, type SheetData, type SheetObject, type SheetSymbol } from "../model/schematic-data"

const ENTRY_STEP = 10
const PIN_DIRECTIONS: Pt[] = [
	{ x: 1, y: 0 },
	{ x: 0, y: 1 },
	{ x: -1, y: 0 },
	{ x: 0, y: -1 },
]

export function sheetRecords(document: AltiumSchDoc): AltiumRecord[] {
	return document.lines.filter((line): line is AltiumRecord => line instanceof AltiumRecord)
}

const location = (r: AltiumRecord): Pt => ({
	x: getSchematicCoordinate(r, { key: "LOCATION.X" }),
	y: getSchematicCoordinate(r, { key: "LOCATION.Y" }),
})

export function extractSheet(document: AltiumSchDoc, additional: AltiumRecord[] = []): SheetData {
	const records = sheetRecords(document)
	const indexOf = new Map(records.map((r, i) => [r, i]))
	const parentIndex = (r: AltiumRecord) => {
		const p = document.getParent(r)
		return p ? indexOf.get(p) : undefined
	}
	const owned = (r: AltiumRecord) => document.getOwnedRecords(r)

	const objects: SheetObject[] = []
	const components: SheetComponent[] = []
	const symbols: SheetSymbol[] = []

	for (const [i, r] of records.entries()) {
		switch (r.recordKind) {
			case "1":
				components.push(extractComponent(document, r, i))
				break
			case "2": {
				const componentIndex = parentIndex(r)
				const component = componentIndex === undefined ? undefined : records[componentIndex]
				if (!component || !isPinOfShownPart(r, component)) break
				const conglomerate = r.getNumber("PINCONGLOMERATE") ?? 0
				const dir = PIN_DIRECTIONS[conglomerate & 3]!
				const length = getSchematicCoordinate(r, { key: "PINLENGTH" })
				const at = location(r)
				const hot = { x: at.x + dir.x * length, y: at.y + dir.y * length }
				const name = r.getDecoded("NAME") ?? ""
				const hidden = (conglomerate & 4) !== 0 || r.getBoolean("ISHIDDEN") === true
				const hiddenNet = r.getDecoded("HIDDENNETNAME")
				if (hidden && hiddenNet) {
					// A hidden power pin joins the net it names, like a power port.
					objects.push({ kind: "power", i, name: hiddenNet, at: hot })
					break
				}
				objects.push({ kind: "pin", i, component: componentIndex!, designator: r.getDecoded("DESIGNATOR") ?? "", name, hot })
				break
			}
			case "27":
				objects.push({ kind: "wire", i, points: getSchematicIndexedPoints(r) })
				break
			case "26":
				objects.push({ kind: "bus", i, points: getSchematicIndexedPoints(r) })
				break
			case "37":
				objects.push({
					kind: "busEntry",
					i,
					points: [location(r), { x: getSchematicCoordinate(r, { key: "CORNER.X" }), y: getSchematicCoordinate(r, { key: "CORNER.Y" }) }],
				})
				break
			case "25":
				objects.push({ kind: "label", i, name: r.getDecoded("TEXT") ?? "", at: location(r) })
				break
			case "17":
				objects.push({ kind: "power", i, name: r.getDecoded("TEXT") ?? "", at: location(r) })
				break
			case "18": {
				const start = location(r)
				const width = getSchematicCoordinate(r, { key: "WIDTH", fallback: 16 })
				const style = r.getNumber("STYLE") ?? 0
				const vertical = style >= 4 && style <= 7
				const end = { x: start.x + (vertical ? 0 : width), y: start.y + (vertical ? width : 0) }
				objects.push({ kind: "port", i, name: r.getDecoded("NAME") ?? "", ends: [start, end], harness: Boolean(r.getDecoded("HARNESSTYPE")) })
				break
			}
			case "15": {
				const children = owned(r)
				symbols.push({
					i,
					designator: children.find(c => c.recordKind === "32")?.getDecoded("TEXT") ?? "",
					fileName: children.find(c => c.recordKind === "33")?.getDecoded("TEXT") ?? "",
					uniqueId: r.getDecoded("UNIQUEID") ?? "",
				})
				break
			}
			case "16": {
				const symbolIndex = parentIndex(r)
				const symbol = symbolIndex === undefined ? undefined : records[symbolIndex]
				if (!symbol || symbol.recordKind !== "15") break
				objects.push({
					kind: "entry",
					i,
					symbol: symbolIndex!,
					name: r.getDecoded("NAME") ?? "",
					at: sheetEntryPoint(r, symbol),
					harness: Boolean(r.getDecoded("HARNESSTYPE")),
				})
				break
			}
		}
	}

	objects.push(...extractHarness(additional))
	return { objects, components, symbols }
}

// A multi-part component's records hold every part's pins; only the shown part's pins exist here.
function isPinOfShownPart(pin: AltiumRecord, component: AltiumRecord): boolean {
	const part = pin.getNumber("OWNERPARTID") ?? -1
	const current = component.getNumber("CURRENTPARTID") ?? 1
	if (part > 0 && part !== current) return false
	const mode = pin.getNumber("OWNERPARTDISPLAYMODE") ?? 0
	return mode === (component.getNumber("DISPLAYMODE") ?? 0)
}

function sheetEntryPoint(entry: AltiumRecord, symbol: AltiumRecord): Pt {
	const origin = location(symbol)
	const width = getSchematicCoordinate(symbol, { key: "XSIZE", fallback: 1 })
	const height = getSchematicCoordinate(symbol, { key: "YSIZE", fallback: 1 })
	const offset = Math.max(entry.getNumber("DISTANCEFROMTOP") ?? 0, 0) * ENTRY_STEP
	switch (Math.round(entry.getNumber("SIDE") ?? 0)) {
		case 1:
			return { x: origin.x + width, y: origin.y - offset }
		case 2:
			return { x: origin.x + offset, y: origin.y }
		case 3:
			return { x: origin.x + offset, y: origin.y - height }
		default:
			return { x: origin.x, y: origin.y - offset }
	}
}

function extractComponent(document: AltiumSchDoc, component: AltiumRecord, i: number): SheetComponent {
	const descendants: AltiumRecord[] = []
	const walk = (r: AltiumRecord) => {
		for (const c of document.getOwnedRecords(r)) {
			descendants.push(c)
			walk(c)
		}
	}
	walk(component)
	const resolve = (text: string, record: AltiumRecord) =>
		resolveSchematicParameterReferenceWithContext({ document, record, reference: text }) ?? text

	const parameters: Parameter[] = []
	let comment = ""
	for (const p of document.getOwnedRecords(component)) {
		if (p.recordKind !== "41") continue
		const name = p.getDecoded("NAME") ?? ""
		const value = resolve(p.getDecoded("TEXT") ?? "", p)
		if (name.toLowerCase() === "comment") comment = value
		else if (name) parameters.push({ name, value })
	}
	parameters.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
	const footprint =
		descendants.find(r => r.recordKind === "45" && /pcblib/i.test(r.getDecoded("MODELTYPE") ?? "") && r.getBoolean("ISCURRENT") === true) ??
		descendants.find(r => r.recordKind === "45" && /pcblib/i.test(r.getDecoded("MODELTYPE") ?? ""))
	return {
		i,
		designator: descendants.find(r => r.recordKind === "34")?.getDecoded("TEXT") ?? "",
		comment,
		description: component.getDecoded("COMPONENTDESCRIPTION") ?? "",
		libReference: component.getDecoded("LIBREFERENCE") ?? "",
		footprint: footprint?.getDecoded("MODELNAME") ?? "",
		uniqueId: component.getDecoded("UNIQUEID") ?? "",
		parameters,
		libraryItem: libraryItem(component.getDecoded("SOURCELIBRARYNAME"), component.getDecoded("DATABASETABLENAME"), component.getDecoded("DESIGNITEMID") || component.getDecoded("LIBREFERENCE")),
		kind: component.getNumber("COMPONENTKIND") ?? 0,
	}
}


// Harness objects from the Additional stream. Entries (216) and type labels (217) belong to the
// connector (215) before them, or to the one named by OWNERINDEX within the Additional list.
function extractHarness(records: AltiumRecord[]): SheetObject[] {
	const out: SheetObject[] = []
	const connectors = new Map<number, Extract<SheetObject, { kind: "harnessConnector" }>>()
	let lastConnector = -1
	for (const [k, r] of records.entries()) {
		const i = ADDITIONAL_BASE + k
		if (r.recordKind === "218") out.push({ kind: "harnessWire", i, points: getSchematicIndexedPoints(r) })
		if (r.recordKind === "215") {
			const at = location(r)
			const tip = { x: at.x, y: at.y - getSchematicCoordinate(r, { key: "PRIMARYCONNECTIONPOSITION", fallback: 0 }) }
			const connector = { kind: "harnessConnector" as const, i, tip, entries: [] as { i: number; name: string; at: Pt }[] }
			connectors.set(k, connector)
			out.push(connector)
			lastConnector = k
		}
		if (r.recordKind === "216") {
			const owner = connectors.get(r.getNumber("OWNERINDEX") ?? lastConnector)
			const ownerRecord = records[r.getNumber("OWNERINDEX") ?? lastConnector]
			if (!owner || !ownerRecord) continue
			const top = getSchematicCoordinate(ownerRecord, { key: "LOCATION.Y" })
			const right = getSchematicCoordinate(ownerRecord, { key: "LOCATION.X" }) + getSchematicCoordinate(ownerRecord, { key: "XSIZE", fallback: 50 })
			owner.entries.push({ i, name: r.getDecoded("NAME") ?? "", at: { x: right, y: top - (r.getNumber("DISTANCEFROMTOP") ?? 0) * ENTRY_STEP } })
		}
	}
	return out
}
