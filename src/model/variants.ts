// Assembly variants, as the project file stores them: one [ProjectVariantN] section per variant, its
// Description the variant's name, and one VariationN line per part the variant changes:
//   Variation1=Designator=R21_1|UniqueId=\1OCQKBGNW\BWCJKGGB|Kind=1|AlternatePart=
// UniqueId is the part's source path (channel index prefixed for REPEAT), the same path a compiled
// component carries (CompiledComponent.uniquePath). Kind 1 = not fitted; 0 = fitted with changed
// parameters (ParamVariationN lines), 2 = fitted with an alternate part.

export interface ProjectVariant {
	name: string
	notFitted: string[] // source paths of the parts this variant leaves off the board
}

const NOT_FITTED = 1

// The variants in the order the project lists them.
export function parseVariants(text: string): ProjectVariant[] {
	const out: { n: number; variant: ProjectVariant }[] = []
	let current: ProjectVariant | null = null
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		const section = /^\[ProjectVariant(\d+)\]$/i.exec(line)
		if (section) {
			current = { name: "", notFitted: [] }
			out.push({ n: Number(section[1]), variant: current })
			continue
		}
		if (line.startsWith("[")) {
			current = null
			continue
		}
		if (!current) continue
		const eq = line.indexOf("=")
		if (eq < 0) continue
		const key = line.slice(0, eq)
		const value = line.slice(eq + 1)
		if (/^Description$/i.test(key)) current.name = value.trim()
		else if (/^Variation\d+$/i.test(key)) {
			const f = fields(value)
			if (Number(f.get("KIND")) === NOT_FITTED && f.get("UNIQUEID")) current.notFitted.push(f.get("UNIQUEID")!)
		}
	}
	return out.sort((a, b) => a.n - b.n).map(({ n, variant }) => ({ ...variant, name: variant.name || `Variant ${n}` }))
}

function fields(value: string): Map<string, string> {
	const out = new Map<string, string>()
	for (const part of value.split("|")) {
		const eq = part.indexOf("=")
		if (eq > 0) out.set(part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim())
	}
	return out
}

// The source paths (upper-cased: the format is not consistent about case) a variant leaves off;
// empty for "[No Variations]" (null) or a name the project doesn't have.
export function notFittedPaths(variants: ProjectVariant[] | undefined, name: string | null): Set<string> {
	const v = name === null ? undefined : variants?.find(v => v.name === name)
	return new Set(v?.notFitted.map(p => p.toUpperCase()) ?? [])
}
