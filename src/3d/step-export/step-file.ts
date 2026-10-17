// Reading a STEP file (ISO 10303-21) just far enough to copy it into another one: its DATA section as
// a list of entity records, renumbered, and the few relationships needed to place its root product in
// an assembly. Pure text work: no geometry is interpreted. Pure: no DOM.

export interface StepEntity {
	id: number
	body: string // everything after "#id=", without the closing ';'
}

// The DATA section's records. Strings ('…', '' inside) and comments (/* … */) are skipped over, so a
// ';' or '#' inside them never splits or renumbers anything.
export function stepEntities(text: string): StepEntity[] {
	const start = text.search(/\bDATA\s*(\([^)]*\))?\s*;/i)
	if (start < 0) return []
	let i = text.indexOf(";", start) + 1
	const out: StepEntity[] = []
	let recordStart = i
	while (i < text.length) {
		const c = text.charCodeAt(i)
		if (c === 39 /* ' */) {
			i = skipString(text, i)
			continue
		}
		if (c === 47 /* / */ && text.charCodeAt(i + 1) === 42 /* * */) {
			const end = text.indexOf("*/", i + 2)
			i = end < 0 ? text.length : end + 2
			continue
		}
		if (c === 59 /* ; */) {
			const record = stripComments(text.slice(recordStart, i)).trim()
			recordStart = i + 1
			i++
			if (/^ENDSEC$/i.test(record)) break
			const m = /^#(\d+)\s*=\s*/.exec(record)
			if (m) out.push({ id: Number(m[1]), body: record.slice(m[0].length) })
			continue
		}
		i++
	}
	return out
}

function skipString(text: string, i: number): number {
	i++
	while (i < text.length) {
		if (text.charCodeAt(i) === 39) {
			if (text.charCodeAt(i + 1) === 39) {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return i
}

function stripComments(body: string): string {
	return body.includes("/*") ? body.replace(/\/\*[\s\S]*?\*\//g, "") : body
}

// An entity body with every reference #n mapped through `map` (strings left alone). Line breaks are
// folded to spaces, so each record is written on one line.
export function renumber(body: string, map: (id: number) => number): string {
	let out = ""
	let last = 0
	for (let i = 0; i < body.length; i++) {
		const c = body.charCodeAt(i)
		if (c === 39) {
			i = skipString(body, i) - 1
			continue
		}
		if (c === 35 /* # */) {
			let j = i + 1
			while (j < body.length && body.charCodeAt(j) >= 48 && body.charCodeAt(j) <= 57) j++
			if (j > i + 1) {
				out += body.slice(last, i) + "#" + map(Number(body.slice(i + 1, j)))
				last = j
				i = j - 1
			}
		}
	}
	return (out + body.slice(last)).replace(/[\r\n]+\s*/g, " ")
}

// The entity type of a simple record (its keyword), or null for a complex one ( (A(…) B(…)) ).
export function typeOf(body: string): string | null {
	const m = /^([A-Z_][A-Z0-9_]*)\s*\(/i.exec(body)
	return m ? m[1]!.toUpperCase() : null
}

// The top-level arguments of a simple record, as raw text: "PRODUCT('a','b','',(#8))" ->
// ["'a'", "'b'", "''", "(#8)"].
export function argsOf(body: string): string[] {
	const open = body.indexOf("(")
	const out: string[] = []
	let depth = 0
	let from = open + 1
	for (let i = open + 1; i < body.length; i++) {
		const c = body.charCodeAt(i)
		if (c === 39) {
			i = skipString(body, i) - 1
			continue
		}
		if (c === 40) depth++
		else if (c === 41) {
			if (depth === 0) {
				out.push(body.slice(from, i).trim())
				return out
			}
			depth--
		} else if (c === 44 && depth === 0) {
			out.push(body.slice(from, i).trim())
			from = i + 1
		}
	}
	return out
}

const refOf = (arg: string | undefined) => (arg && /^#\d+$/.test(arg) ? Number(arg.slice(1)) : null)
const refsOf = (arg: string | undefined) => [...(arg ?? "").matchAll(/#(\d+)/g)].map(m => Number(m[1]))

// What an assembly needs to place a model: each root product definition (one no other product in the
// file uses as a part) with its shape representation, and an axis placement among that
// representation's items to place it by.
export interface StepRoot {
	productDefinition: number
	representation: number
	axis: number | null // null: the representation has none (one must be added to its items)
}

export function stepRoots(entities: StepEntity[]): StepRoot[] {
	const byId = new Map(entities.map(e => [e.id, e]))
	const definitions: number[] = []
	const used = new Set<number>()
	const shapeOf = new Map<number, number>() // product definition -> its PRODUCT_DEFINITION_SHAPE
	const repOf = new Map<number, number>() // PRODUCT_DEFINITION_SHAPE -> representation
	for (const e of entities) {
		const t = typeOf(e.body)
		if (t === "PRODUCT_DEFINITION" || t === "PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS") definitions.push(e.id)
		else if (t === "NEXT_ASSEMBLY_USAGE_OCCURRENCE") {
			const child = refOf(argsOf(e.body)[4])
			if (child !== null) used.add(child)
		} else if (t === "PRODUCT_DEFINITION_SHAPE") {
			const of = refOf(argsOf(e.body)[2])
			if (of !== null && byId.get(of) && /^PRODUCT_DEFINITION(_WITH_ASSOCIATED_DOCUMENTS)?\s*\(/i.test(byId.get(of)!.body)) shapeOf.set(of, e.id)
		} else if (t === "SHAPE_DEFINITION_REPRESENTATION") {
			const [def, rep] = argsOf(e.body).map(refOf)
			if (def != null && rep != null && !repOf.has(def)) repOf.set(def, rep)
		}
	}
	const out: StepRoot[] = []
	for (const pd of definitions) {
		if (used.has(pd)) continue
		const pds = shapeOf.get(pd)
		const rep = pds !== undefined ? repOf.get(pds) : undefined
		if (rep === undefined || !byId.has(rep)) continue
		const items = refsOf(argsOf(byId.get(rep)!.body)[1])
		// Only an axis that IS the representation's own frame places it as is: many models list axes
		// turned or moved (a part's own sub-frames), and placing by one of those turns or moves the part.
		const axis = items.find(id => isIdentityAxis(byId, id)) ?? null
		out.push({ productDefinition: pd, representation: rep, axis })
	}
	return out
}

// Whether an entity is AXIS2_PLACEMENT_3D at (0,0,0) with z up and x along x (or those left unset).
function isIdentityAxis(byId: Map<number, StepEntity>, id: number): boolean {
	const e = byId.get(id)
	if (!e || typeOf(e.body) !== "AXIS2_PLACEMENT_3D") return false
	const [, location, z, x] = argsOf(e.body)
	const coords = (ref: string | undefined, type: string): number[] | null => {
		const target = refOf(ref)
		const t = target !== null ? byId.get(target) : undefined
		if (!t || typeOf(t.body) !== type) return null
		const list = argsOf(t.body)[1] ?? ""
		return list.replace(/[()\s]/g, "").split(",").map(Number)
	}
	const near = (a: number[] | null, b: number[]) => a !== null && a.length === 3 && a.every((v, i) => Math.abs(v - b[i]!) < 1e-9)
	return near(coords(location, "CARTESIAN_POINT"), [0, 0, 0]) && (z === "$" || near(coords(z, "DIRECTION"), [0, 0, 1])) && (x === "$" || near(coords(x, "DIRECTION"), [1, 0, 0]))
}

// A representation's record with one more item in its items list (the second argument).
export function withItem(body: string, item: number): string {
	const args = argsOf(body)
	const open = body.indexOf("(")
	const items = args[1]!.trim()
	const added = items === "()" ? `(#${item})` : items.replace(/\)\s*$/, `,#${item})`)
	// Rebuild only the items argument; the rest of the record is kept verbatim.
	let depth = 0
	let argIndex = 0
	let from = -1
	for (let i = open + 1; i < body.length; i++) {
		const c = body.charCodeAt(i)
		if (c === 39) {
			i = skipString(body, i) - 1
			continue
		}
		if (c === 40) {
			if (depth === 0 && argIndex === 1) from = i
			depth++
		} else if (c === 41) {
			depth--
			if (depth === 0 && argIndex === 1 && from >= 0) return body.slice(0, from) + added + body.slice(i + 1)
		} else if (c === 44 && depth === 0) argIndex++
	}
	return body
}
