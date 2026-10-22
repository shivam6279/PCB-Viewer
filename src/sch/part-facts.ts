// What a part's card and the PDF's parts list say about a part. Pure.
import type { CompiledComponent } from "../model/compile"
import type { Parameter } from "../model/schematic-data"

// The key facts first, by the parameter names libraries use for them; then every other parameter
// that has a value. Component links (datasheets) as links.
const KEY_PARAMS: { label: string; name: RegExp }[] = [
	{ label: "Value", name: /^value$/i },
	{ label: "Part Number", name: /^(manufacturer[ _-]?)?part[ _-]?(number|no\.?)[ _-]?1?$|^mpn[ _-]?1?$|^mfr\.?[ _-]?part/i },
	{ label: "Manufacturer", name: /^(manufacturer|mfr\.?)([ _-]?name)?[ _-]?1?$/i },
	{ label: "Supplier", name: /^supplier[ _-]?1?$/i },
	{ label: "Supplier Part Number", name: /^supplier[ _-]?part[ _-]?(number|no\.?)[ _-]?1?$/i },
]
const LINK = /^ComponentLink(\d+)(Description|URL)$/i

export interface PartFact {
	label: string
	value: string
}

// What the card lists for a part: key facts, the other parameters, and its links. Pure.
export function partFacts(c: CompiledComponent): { key: PartFact[]; other: Parameter[]; links: { text: string; url: string }[] } {
	const params = c.parameters.filter(p => p.value.trim() !== "" && p.value.trim() !== "*")
	const used = new Set<Parameter>()
	const key: PartFact[] = []
	for (const k of KEY_PARAMS) {
		const p = params.find(p => k.name.test(p.name.trim()) && !used.has(p))
		if (!p) continue
		used.add(p)
		if (k.label === "Value" && p.value.trim() === c.comment.trim()) continue // the heading already says it
		key.push({ label: k.label, value: p.value.trim() })
	}
	if (c.footprint) key.push({ label: "Footprint", value: c.footprint })
	if (c.libReference) key.push({ label: "Library Ref", value: c.libReference })

	const byIndex = new Map<string, { description?: string; url?: string }>()
	for (const p of params) {
		const m = LINK.exec(p.name)
		if (!m) continue
		used.add(p)
		const entry = byIndex.get(m[1]!) ?? {}
		if (m[2]!.toLowerCase() === "url") entry.url = p.value.trim()
		else entry.description = p.value.trim()
		byIndex.set(m[1]!, entry)
	}
	const links = [...byIndex.values()].filter(l => l.url && /^https?:\/\//i.test(l.url)).map(l => ({ text: l.description || l.url!, url: l.url! }))
	// The same link may be listed under several numbers or spellings.
	const unique = links.filter((l, k) => links.findIndex(m => m.url === l.url) === k)
	return { key, other: params.filter(p => !used.has(p)), links: unique }
}
