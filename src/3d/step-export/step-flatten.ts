// A STEP model's assembly flattened, for an export written as one part: the representations holding
// its bodies, each with where it sits in the model's own frame (mm), and the records they need. The
// model's product structure (its parts and their placements) is left out: the bodies go into the one
// part as mapped items. Pure text work: only placements are read as numbers. Pure: no DOM.
import { argsOf, renumber, stepRoots, typeOf, type StepEntity } from "./step-file"

// A rigid placement: rotation (3x3, row-major) then translation (mm).
export interface Placement {
	r: number[]
	t: [number, number, number]
}

export const IDENTITY: Placement = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }

// `a` after `b`: x -> a(b(x)).
export function compose(a: Placement, b: Placement): Placement {
	const r = new Array<number>(9).fill(0)
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j]! += a.r[i * 3 + k]! * b.r[k * 3 + j]!
	const t = [0, 1, 2].map(i => a.r[i * 3]! * b.t[0] + a.r[i * 3 + 1]! * b.t[1] + a.r[i * 3 + 2]! * b.t[2] + a.t[i]!) as [number, number, number]
	return { r, t }
}

function invert(a: Placement): Placement {
	const r = [a.r[0]!, a.r[3]!, a.r[6]!, a.r[1]!, a.r[4]!, a.r[7]!, a.r[2]!, a.r[5]!, a.r[8]!]
	const t = [0, 1, 2].map(i => -(r[i * 3]! * a.t[0] + r[i * 3 + 1]! * a.t[1] + r[i * 3 + 2]! * a.t[2])) as [number, number, number]
	return { r, t }
}

// A placement from an axis's origin and its z and x directions (x made square to z).
export function placementOf(origin: number[], z: number[], x: number[]): Placement {
	const unit = (v: number[]) => {
		const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1
		return v.map(c => c / l)
	}
	const zz = unit(z)
	const d = x[0]! * zz[0]! + x[1]! * zz[1]! + x[2]! * zz[2]!
	let xx = [x[0]! - d * zz[0]!, x[1]! - d * zz[1]!, x[2]! - d * zz[2]!]
	if (Math.hypot(xx[0]!, xx[1]!, xx[2]!) < 1e-12) xx = Math.abs(zz[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0]
	xx = unit(xx)
	const yy = [zz[1]! * xx[2]! - zz[2]! * xx[1]!, zz[2]! * xx[0]! - zz[0]! * xx[2]!, zz[0]! * xx[1]! - zz[1]! * xx[0]!]
	return { r: [xx[0]!, yy[0]!, zz[0]!, xx[1]!, yy[1]!, zz[1]!, xx[2]!, yy[2]!, zz[2]!], t: [origin[0]!, origin[1]!, origin[2]!] }
}

const refOf = (arg: string | undefined) => (arg && /^#\d+$/.test(arg.trim()) ? Number(arg.trim().slice(1)) : null)
const refsOf = (text: string) => [...text.replace(/'(?:[^']|'')*'/g, "").matchAll(/#(\d+)/g)].map(m => Number(m[1]))

// The parts of a complex record, "(A(…) B(…))", by name, each as its arguments.
function partsOf(body: string): Map<string, string[]> {
	const out = new Map<string, string[]>()
	const simple = typeOf(body)
	if (simple) {
		out.set(simple, argsOf(body))
		return out
	}
	const s = body.trim().replace(/^\(/, "").replace(/\)$/, "")
	let i = 0
	while (i < s.length) {
		const m = /^\s*([A-Z_][A-Z0-9_]*)\s*\(/i.exec(s.slice(i))
		if (!m) break
		const start = i + m[0].length - 1
		let depth = 0
		let j = start
		for (; j < s.length; j++) {
			const c = s[j]
			if (c === "'") {
				j++
				while (j < s.length && !(s[j] === "'" && s[j + 1] !== "'")) j += s[j] === "'" ? 2 : 1
			} else if (c === "(") depth++
			else if (c === ")" && --depth === 0) break
		}
		out.set(m[1]!.toUpperCase(), argsOf(`${m[1]}${s.slice(start, j + 1)}`))
		i = j + 1
	}
	return out
}

// Items that are bodies (or carry them): a representation holding any is placed into the part.
const BODIES = new Set(["MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "SHELL_BASED_SURFACE_MODEL", "FACETED_BREP", "MAPPED_ITEM"])

export interface FlatModel {
	leaves: { rep: number; at: Placement; items: number[]; units: number }[] // each representation with bodies (its body items, mm per unit), as placed in the model's frame
	keep: number[] // the records they need (and their colours), in the file's order
	styled: number[] // the colours among them (styled items)
	units: number // mm per unit of the model's root representation
}

export function flattenModel(entities: StepEntity[]): FlatModel | null {
	const byId = new Map(entities.map(e => [e.id, e]))
	const body = (id: number | null) => (id !== null ? byId.get(id)?.body : undefined)
	const roots = stepRoots(entities)
	if (!roots.length) return null

	// A representation's items and context.
	const repArgs = (id: number) => {
		const b = body(id)
		if (!b) return null
		const parts = partsOf(b)
		const args = typeOf(b) ? parts.values().next().value : (parts.get("REPRESENTATION") ?? [...parts.values()].find(a => a.length >= 3))
		return args && args.length >= 3 ? { items: refsOf(args[1]!), context: refOf(args[2]) } : null
	}
	// mm per length unit of a context (1 for mm or unknown).
	const unitMemo = new Map<number, number>()
	const unitFactor = (unit: number): number => {
		const parts = partsOf(body(unit) ?? "")
		const si = parts.get("SI_UNIT")
		if (si) {
			const prefix = (si.length === 2 ? si[0] : si[1])?.trim() ?? "$"
			return ({ ".MILLI.": 1, ".CENTI.": 10, ".DECI.": 100, ".MICRO.": 1e-3, ".KILO.": 1e6 } as Record<string, number>)[prefix] ?? 1000
		}
		const conv = parts.get("CONVERSION_BASED_UNIT")
		if (conv) {
			const measure = partsOf(body(refOf(conv[1])) ?? "")
			const args = measure.get("LENGTH_MEASURE_WITH_UNIT") ?? measure.get("MEASURE_WITH_UNIT")
			const value = Number(/\(\s*([-+0-9.Ee]+)\s*\)/.exec(args?.[0] ?? "")?.[1])
			const of = refOf(args?.[1])
			if (Number.isFinite(value) && of !== null) return value * unitFactor(of)
		}
		return 1
	}
	const contextUnits = (context: number | null) => {
		if (context === null) return 1
		if (!unitMemo.has(context)) {
			const units = partsOf(body(context) ?? "").get("GLOBAL_UNIT_ASSIGNED_CONTEXT")
			const length = refsOf(units?.[0] ?? "").find(u => partsOf(body(u) ?? "").has("LENGTH_UNIT"))
			unitMemo.set(context, length !== undefined ? unitFactor(length) : 1)
		}
		return unitMemo.get(context)!
	}
	const repUnits = (rep: number) => contextUnits(repArgs(rep)?.context ?? null)
	// An axis placement as a Placement, its origin scaled to mm.
	const coords = (id: number | null) => {
		const list = argsOf(body(id) ?? "X()")[1] ?? ""
		return list.replace(/[()\s]/g, "").split(",").map(Number)
	}
	const axisPlacement = (id: number | null, scale: number): Placement => {
		const a = argsOf(body(id) ?? "X()")
		const origin = coords(refOf(a[1])).map(v => v * scale)
		const z = refOf(a[2]) !== null ? coords(refOf(a[2])) : [0, 0, 1]
		const x = refOf(a[3]) !== null ? coords(refOf(a[3])) : [1, 0, 0]
		return placementOf(origin.length === 3 ? origin : [0, 0, 0], z, x)
	}

	// The assembly's links: product definition -> its representation; placements of one in another.
	const pdsOf = new Map<number, number>() // product definition -> PRODUCT_DEFINITION_SHAPE
	const repOfPds = new Map<number, number>()
	const nauoOfPds = new Map<number, number>()
	const nauoOfRel = new Map<number, number>()
	const placed: { rel: number; rep1: number; rep2: number; transform: number | null }[] = []
	const same: [number, number][] = [] // representations of one shape (no placement)
	for (const e of entities) {
		const t = typeOf(e.body)
		if (t === "PRODUCT_DEFINITION_SHAPE") {
			const of = refOf(argsOf(e.body)[2])
			const target = body(of) ?? ""
			if (/^NEXT_ASSEMBLY_USAGE_OCCURRENCE/i.test(target)) nauoOfPds.set(e.id, of!)
			else if (of !== null) pdsOf.set(of, e.id)
		} else if (t === "SHAPE_DEFINITION_REPRESENTATION") {
			const [pds, rep] = argsOf(e.body).map(refOf)
			if (pds != null && rep != null && !repOfPds.has(pds)) repOfPds.set(pds, rep)
		} else if (t === "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION") {
			const [rel, pds] = argsOf(e.body).map(refOf)
			if (rel != null && pds != null) nauoOfRel.set(rel, pds)
		} else if (t === "SHAPE_REPRESENTATION_RELATIONSHIP" || t === "REPRESENTATION_RELATIONSHIP") {
			const a = argsOf(e.body)
			const [r1, r2] = [refOf(a[2]), refOf(a[3])]
			if (r1 !== null && r2 !== null) same.push([r1, r2])
		} else if (t === null) {
			const parts = partsOf(e.body)
			const rel = parts.get("REPRESENTATION_RELATIONSHIP")
			const with_ = parts.get("REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION")
			if (rel && with_) placed.push({ rel: e.id, rep1: refOf(rel[2])!, rep2: refOf(rel[3])!, transform: refOf(with_[0]) })
			else if (rel) same.push([refOf(rel[2])!, refOf(rel[3])!])
		}
	}
	const repOfPd = (pd: number | null) => (pd !== null && pdsOf.has(pd) ? repOfPds.get(pdsOf.get(pd)!) : undefined)
	// Each placement as parent -> child, with the child's placement in the parent's frame.
	const children = new Map<number, { rep: number; at: Placement }[]>()
	for (const p of placed) {
		let child = p.rep1
		const nauo = nauoOfPds.get(nauoOfRel.get(p.rel) ?? -1)
		if (nauo !== undefined) {
			const a = argsOf(body(nauo) ?? "X()")
			const childRep = repOfPd(refOf(a[4])), parentRep = repOfPd(refOf(a[3]))
			if (childRep === p.rep2 || parentRep === p.rep1) child = p.rep2
		}
		const parent = child === p.rep1 ? p.rep2 : p.rep1
		const tr = body(p.transform) ?? ""
		if (typeOf(tr) !== "ITEM_DEFINED_TRANSFORMATION") continue // (a transformation operator: not seen in the corpus)
		const ta = argsOf(tr)
		const a1 = axisPlacement(refOf(ta[2]), repUnits(p.rep1)), a2 = axisPlacement(refOf(ta[3]), repUnits(p.rep2))
		const at = child === p.rep1 ? compose(a2, invert(a1)) : compose(a1, invert(a2))
		children.set(parent, [...(children.get(parent) ?? []), { rep: child, at }])
	}
	const sameAs = new Map<number, number[]>()
	for (const [a, b] of same) {
		sameAs.set(a, [...(sameAs.get(a) ?? []), b])
		sameAs.set(b, [...(sameAs.get(b) ?? []), a])
	}

	const leaves: FlatModel["leaves"] = []
	const visit = (rep: number, at: Placement, path: Set<number>) => {
		if (path.has(rep) || path.size > 32) return
		const args = repArgs(rep)
		if (!args) return
		const next = new Set(path).add(rep)
		const items = args.items.filter(i => BODIES.has(typeOf(body(i) ?? "") ?? ""))
		if (items.length) leaves.push({ rep, at, items, units: contextUnits(args.context) })
		for (const c of children.get(rep) ?? []) visit(c.rep, compose(at, c.at), next)
		for (const s of sameAs.get(rep) ?? []) visit(s, at, next)
	}
	for (const root of roots) visit(root.representation, IDENTITY, new Set())
	if (!leaves.length) return null

	// The records the representations need, and the colours on them.
	const keep = new Set<number>()
	const add = (id: number) => {
		const stack = [id]
		while (stack.length) {
			const i = stack.pop()!
			if (keep.has(i) || !byId.has(i)) continue
			keep.add(i)
			stack.push(...refsOf(byId.get(i)!.body))
		}
	}
	for (const l of leaves) add(l.rep)
	const styled: number[] = []
	for (const e of entities) {
		const t = typeOf(e.body)
		if (t !== "STYLED_ITEM" && t !== "OVER_RIDING_STYLED_ITEM") continue
		const target = refOf(argsOf(e.body)[2])
		if (target === null || !keep.has(target)) continue
		styled.push(e.id)
	}
	for (const s of styled) add(s)
	return { leaves, keep: entities.filter(e => keep.has(e.id)).map(e => e.id), styled, units: repUnits(roots[0]!.representation) }
}


// A model's bodies copied into another file at any placement, as plain bodies (no mapped items: CAD
// made every mapped item a component of an assembly). Per placement only the records that move are
// written again (3D points and directions, and what is built on them); the rest (colours, curves in a
// surface's own parameters, contexts) once, shared by every copy. A model in other units than mm is
// scaled as it is copied; its edges then keep only their 3D curves (their curves in surface
// parameters would need scaling per surface type).
export interface Sink {
	reserve(count: number): number
	push(line: string): void
}

// Arguments that are lengths, per record type (scaled with a model's units).
const LENGTHS: Record<string, number[]> = {
	CIRCLE: [2],
	ELLIPSE: [2, 3],
	VECTOR: [2],
	CYLINDRICAL_SURFACE: [2],
	CONICAL_SURFACE: [2],
	SPHERICAL_SURFACE: [2],
	TOROIDAL_SURFACE: [2, 3],
	DEGENERATE_TOROIDAL_SURFACE: [2, 3],
	OFFSET_SURFACE: [2],
	OFFSET_CURVE_3D: [2],
}

export function modelPlacer(entities: StepEntity[], num: (v: number) => string) {
	const model = flattenModel(entities)
	if (!model) return null
	const byId = new Map(entities.map(e => [e.id, e]))
	const order = new Map(entities.map((e, i) => [e.id, i]))
	const tuple = (body: string) => (argsOf(body)[1] ?? "").replace(/[()\s]/g, "").split(",").map(Number)

	// Whether a record moves with a placement: a 3D point or direction, or built on one.
	const moves = new Map<number, boolean>()
	const movesOf = (id: number): boolean => {
		const known = moves.get(id)
		if (known !== undefined) return known
		moves.set(id, false) // (a cycle counts as fixed)
		const e = byId.get(id)
		if (!e) return false
		const t = typeOf(e.body)
		const v = (t === "CARTESIAN_POINT" || t === "DIRECTION") ? tuple(e.body).length === 3 : refsOf(e.body).some(movesOf)
		moves.set(id, v)
		return v
	}
	const closure = (ids: number[]) => {
		const seen = new Set<number>()
		const stack = [...ids]
		while (stack.length) {
			const i = stack.pop()!
			if (seen.has(i) || !byId.has(i)) continue
			seen.add(i)
			stack.push(...refsOf(byId.get(i)!.body))
		}
		return seen
	}
	const styles = entities.filter(e => typeOf(e.body) === "STYLED_ITEM" || typeOf(e.body) === "OVER_RIDING_STYLED_ITEM")
	const leaves = model.leaves.map(l => {
		const ids = closure(l.items)
		const moving = [...ids].filter(movesOf).sort((a, b) => order.get(a)! - order.get(b)!)
		const styled = styles.filter(s => ids.has(refOf(argsOf(s.body)[2]) ?? -1)).map(s => s.id)
		const fixed = new Set([...ids].filter(i => !movesOf(i)))
		for (const s of styled) for (const i of closure(refsOf(argsOf(byId.get(s)!.body)[1] ?? ""))) fixed.add(i)
		return { ...l, moving, styled, fixed }
	})

	// The records every copy shares, written with the first.
	let shared: Map<number, number> | null = null
	const writeShared = (sink: Sink) => {
		const ids = [...new Set(leaves.flatMap(l => [...l.fixed]))].sort((a, b) => order.get(a)! - order.get(b)!)
		const first = sink.reserve(ids.length)
		shared = new Map(ids.map((id, i) => [id, first + i]))
		for (const id of ids) sink.push(`#${shared.get(id)}=${renumber(byId.get(id)!.body, r => shared!.get(r) ?? r)};`)
	}

	// The model's bodies at `at` (mm): their new ids (named `name`) and the copies of their colours.
	return (sink: Sink, at: Placement, name: string): { bodies: number[]; styled: number[] } => {
		if (!shared) writeShared(sink)
		const bodies: number[] = []
		const styled: number[] = []
		for (const leaf of leaves) {
			const p = compose(at, leaf.at)
			const s = leaf.units
			const first = sink.reserve(leaf.moving.length + leaf.styled.length)
			const fresh = new Map(leaf.moving.map((id, i) => [id, first + i]))
			const ref = (r: number) => fresh.get(r) ?? shared!.get(r) ?? r
			const bodySet = new Set(leaf.items)
			for (const id of leaf.moving) {
				const body = byId.get(id)!.body
				const t = typeOf(body)
				let out = body
				if (t) {
					const args = argsOf(body)
					if (t === "CARTESIAN_POINT") {
						const [x, y, z] = tuple(body).map(v => v * s)
						args[1] = `(${[0, 1, 2].map(i => num(p.r[i * 3]! * x! + p.r[i * 3 + 1]! * y! + p.r[i * 3 + 2]! * z! + p.t[i]!)).join(",")})`
					} else if (t === "DIRECTION") {
						const [x, y, z] = tuple(body)
						args[1] = `(${[0, 1, 2].map(i => num(p.r[i * 3]! * x! + p.r[i * 3 + 1]! * y! + p.r[i * 3 + 2]! * z!)).join(",")})`
					} else if (s !== 1) {
						for (const i of LENGTHS[t] ?? []) if (args[i] !== undefined && Number.isFinite(Number(args[i]))) args[i] = num(Number(args[i]) * s)
						if (t === "EDGE_CURVE") {
							// Its curve in 3D only (see above).
							const curve = byId.get(refOf(args[3]) ?? -1)?.body ?? ""
							if (/^(SURFACE_CURVE|SEAM_CURVE|INTERSECTION_CURVE)\s*\(/i.test(curve)) args[3] = argsOf(curve)[1]!
						}
					}
					if (bodySet.has(id)) args[0] = `'${name.replace(/'/g, "''")}'`
					out = `${t}(${args.join(",")})`
				}
				sink.push(`#${fresh.get(id)}=${renumber(out, ref)};`)
			}
			leaf.styled.forEach((sid, k) => {
				const body = byId.get(sid)!.body
				const args = argsOf(body)
				const target = refOf(args[2])
				const over = typeOf(body) === "OVER_RIDING_STYLED_ITEM" ? refOf(args[3]) : null
				const map = (r: number) => {
					if (r === target) return ref(r)
					if (r === over && leaf.styled.includes(r)) return first + leaf.moving.length + leaf.styled.indexOf(r)
					return shared!.get(r) ?? r
				}
				const id = first + leaf.moving.length + k
				sink.push(`#${id}=${renumber(body, map)};`)
				styled.push(id)
			})
			for (const item of leaf.items) bodies.push(fresh.get(item) ?? shared!.get(item) ?? item)
		}
		return { bodies, styled }
	}
}
