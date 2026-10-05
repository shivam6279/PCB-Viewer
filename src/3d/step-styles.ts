// Colours a STEP file assigns to its solids and faces (STYLED_ITEM -> ... -> COLOUR_RGB), read from the
// file's text, as written (sRGB). occt-import-js misses some of them (Amass MR30 connectors: every face
// styled yellow, yet it returns none) and resolves part-vs-solid colours inconsistently, so the STEP
// worker takes the solids' colours from here. Pure.
export type StepRgb = [number, number, number]

export interface StepSolid {
	// The solid's colour: its own style or the whole part's (a style on the shape representation, e.g.
	// a SolidWorks part appearance). In a part of several solids each solid
	// keeps its own (MPU6050 body black, XB3 module shield silver and PCB dark, though both parts are
	// styled lavender); in a one-solid part the style the file lists first wins (CAP 1206-0.8mm: part
	// lavender first, solid brown -> lavender; LED 0603 Lens GREEN: solid green first -> green).
	color: StepRgb | null
	faces: (StepRgb | null)[] // each face's own style, in shell order
}

export interface StepStyles {
	solids: StepSolid[] // in the order the file's shape representation lists them
	colors: StepRgb[] // every distinct colour used
}

interface Entity {
	type: string
	args: string
	order: number // position in the file
}

export function parseStepEntities(text: string): Map<number, Entity> {
	const out = new Map<number, Entity>()
	const data = text.indexOf("DATA;")
	const re = /#(\d+)\s*=\s*([A-Z0-9_]*)\s*\(([\s\S]*?)\)\s*;\s*(?=#\d+\s*=|ENDSEC)/g
	re.lastIndex = data >= 0 ? data : 0
	let order = 0
	for (let m = re.exec(text); m; m = re.exec(text)) out.set(Number(m[1]), { type: m[2] || "COMPLEX", args: m[3]!, order: order++ })
	return out
}

const refs = (args: string) => [...args.matchAll(/#(\d+)/g)].map(m => Number(m[1]))

export function stepStyles(text: string): StepStyles | null {
	const e = parseStepEntities(text)
	const colourOf = new Map<number, StepRgb | null>()
	// The first COLOUR_RGB reachable from an entity (a style assignment chain).
	const findColour = (id: number, depth = 0): StepRgb | null => {
		if (colourOf.has(id)) return colourOf.get(id)!
		const ent = e.get(id)
		let c: StepRgb | null = null
		if (ent && depth < 12) {
			if (ent.type === "COLOUR_RGB") {
				const n = ent.args.split(",").slice(1).map(s => Number.parseFloat(s.trim()))
				if (n.length === 3 && n.every(Number.isFinite)) c = [n[0]!, n[1]!, n[2]!]
			} else if (ent.type !== "CURVE_STYLE")
				for (const r of refs(ent.args)) {
					c = findColour(r, depth + 1)
					if (c) break
				}
		}
		colourOf.set(id, c)
		return c
	}
	// Target (solid, face or representation) -> its first style's colour and that style's place.
	const styled = new Map<number, { color: StepRgb; order: number }>()
	for (const [, ent] of e) {
		if (ent.type !== "STYLED_ITEM" && ent.type !== "OVER_RIDING_STYLED_ITEM") continue
		const r = refs(ent.args)
		const target = r[r.length - 1]
		if (target === undefined || styled.has(target)) continue
		for (const s of r.slice(0, -1)) {
			const c = findColour(s)
			if (c) {
				styled.set(target, { color: c, order: ent.order })
				break
			}
		}
	}
	if (styled.size === 0) return null

	const isSolid = (t: string) => t === "MANIFOLD_SOLID_BREP" || t === "BREP_WITH_VOIDS"
	const reps = [...e].filter(([, ent]) => /SHAPE_REPRESENTATION$/.test(ent.type))
	let solidIds: number[] = []
	const partOf = new Map<number, { color: StepRgb; order: number; single: boolean }>()
	for (const [id, ent] of reps) {
		const own = refs(ent.args).filter(r => isSolid(e.get(r)?.type ?? ""))
		for (const r of own) {
			if (!solidIds.includes(r)) solidIds.push(r)
			const part = styled.get(id)
			if (part && !partOf.has(r)) partOf.set(r, { ...part, single: own.length === 1 })
		}
	}
	if (solidIds.length === 0) solidIds = [...e].filter(([, ent]) => isSolid(ent.type)).map(([id]) => id)

	const solids = solidIds.map(id => {
		const own = styled.get(id)
		const part = partOf.get(id)
		const first = own && part ? (part.single && part.order < own.order ? part : own) : (own ?? part)
		const color = first?.color ?? null
		const faces: (StepRgb | null)[] = []
		for (const shell of refs(e.get(id)!.args)) {
			const s = e.get(shell)
			if (!s || !/SHELL/.test(s.type)) continue
			for (const f of refs(s.args)) faces.push(styled.get(f)?.color ?? null)
		}
		return { color, faces }
	})
	const seen = new Map<string, StepRgb>()
	for (const { color } of styled.values()) seen.set(color.join(","), color)
	return { solids, colors: [...seen.values()] }
}
