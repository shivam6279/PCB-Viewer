// Plain, structured-clone-able description of what a schematic sheet contains for connectivity and
// inspection. Produced in the parse worker from altiumts records (src/parse/extract-sheet.ts).
// `i` is the object's identity on the sheet: the record index the renderer writes as data-i, so a
// click on the drawing maps back to these objects. Records from the Additional stream (harnesses)
// are numbered from ADDITIONAL_BASE.

export const ADDITIONAL_BASE = 100_000

export interface Pt {
	x: number
	y: number
}

export interface Parameter {
	name: string
	value: string
}

export type SheetObject =
	| { kind: "wire"; i: number; points: Pt[] }
	| { kind: "pin"; i: number; component: number; designator: string; name: string; hot: Pt }
	| { kind: "label"; i: number; name: string; at: Pt }
	| { kind: "power"; i: number; name: string; at: Pt }
	| { kind: "port"; i: number; name: string; ends: Pt[]; harness: boolean }
	| { kind: "offsheet"; i: number; name: string; at: Pt }
	| { kind: "entry"; i: number; symbol: number; name: string; at: Pt; harness: boolean }
	| { kind: "harnessWire"; i: number; points: Pt[] }
	| { kind: "harnessConnector"; i: number; tip: Pt; entries: { i: number; name: string; at: Pt }[] }

export interface SheetComponent {
	i: number
	designator: string
	comment: string
	description: string
	libReference: string
	footprint: string
	uniqueId: string
	parameters: Parameter[]
	// The library item it was placed from, as a BOM document names it: "<library>[/<table>]\<item>".
	libraryItem?: string
	kind?: number // the format's component kind: 2 graphical, 4 net tie and 5 standard are left out of a BOM
}

export interface SheetSymbol {
	i: number
	designator: string
	fileName: string
	uniqueId: string
}

export interface SheetData {
	objects: SheetObject[]
	components: SheetComponent[]
	symbols: SheetSymbol[]
}
