import { readFileSync } from "node:fs"
import occtFactory from "occt-import-js"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { outerLayers } from "../board-geometry"
import { exportStep, layerColours } from "./export-step"
import { DEFAULT_STEP_OPTIONS } from "./options"
import { SAMPLE_MODELS, sampleBoard } from "./sample-board"

const { scene, board } = sampleBoard()

test("the solder mask opens over pads only with copper; with no copper, only where the board is drilled", () => {
	const openings = (copper: boolean, viaHoles: boolean) => outerLayers(scene, board, { viaHoles, exposedOnly: false, copper }).mask.top.reduce((n, r) => n + r.holes.length, 0)
	// R1's two pads, J1's two pins, the mounting hole, the open via (never the tented one), drilled or not.
	expect(openings(true, true)).toBe(6)
	expect(openings(true, false)).toBe(6)
	// No copper: only where the board is drilled (J1's pins and the mounting hole, and the open via if
	// drilled).
	expect(openings(false, false)).toBe(3)
	expect(openings(false, true)).toBe(4)
})

test("with only the exposed copper, a pad's opening is the pad itself: no track or bare board in its margin", () => {
	const area = (pts: number[]) => Math.abs(pts.reduce((a, v, i) => (i % 2 ? a : a + v * pts[(i + 3) % pts.length]! - pts[(i + 2) % pts.length]! * pts[i + 1]!), 0) / 2)
	const inside = (pts: number[], x: number, y: number) => {
		const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1)
		return Math.min(...xs) <= x && x <= Math.max(...xs) && Math.min(...ys) <= y && y <= Math.max(...ys)
	}
	// R1's pad 1: 33.5 x 37.4 mils at (84.4, 70), its mask expanded 4 mils.
	const pad = 33.5 * 37.4
	const layers = outerLayers(scene, board, { viaHoles: false, exposedOnly: true })
	const opening = layers.mask.top.flatMap(r => r.holes).filter(h => inside(h, 84.4, 70))
	expect(opening).toHaveLength(1)
	expect(area(opening[0]!)).toBeCloseTo(pad, 0)
	const copper = layers.copper.top.filter(r => inside(r.outer, 84.4, 70))
	expect(copper).toHaveLength(1)
	expect(area(copper[0]!.outer)).toBeCloseTo(pad, 0)
	// The open via likewise: its 30 mil pad, not the 2 mils of expansion round it. The tented one stays
	// covered.
	const via = layers.mask.top.flatMap(r => r.holes).filter(h => inside(h, 300, 70))
	expect(via).toHaveLength(1)
	expect(area(via[0]!)).toBeGreaterThan(Math.PI * 14 * 14)
	expect(area(via[0]!)).toBeLessThan(Math.PI * 15.5 * 15.5)
	expect(layers.mask.top.flatMap(r => r.holes).filter(h => inside(h, 400, 70))).toHaveLength(0)
	// All the copper drawn: the mask's openings as the board has them.
	const all = outerLayers(scene, board, { viaHoles: false, exposedOnly: false }).mask.top.flatMap(r => r.holes).filter(h => inside(h, 84.4, 70))
	expect(area(all[0]!)).toBeGreaterThan(pad + 100)
})

test("the preview board exports every layer and both parts, each layer under its colour's name", () => {
	const models = new Map<string, Uint8Array | null>()
	for (const m of Object.values(SAMPLE_MODELS)) models.set(m.key, new Uint8Array(readFileSync(fileURLToPath(m.url))))
	const { bytes, parts, missing } = exportStep(scene, board, models, "Preview", { ...DEFAULT_STEP_OPTIONS, onePart: false, copperUnderMask: true })
	expect(parts).toBe(2)
	expect(missing).toEqual([])
	const names = [...new TextDecoder("latin1").decode(bytes).matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('\d+','([^']*)'/g)].map(m => m[1])
	// The board's top layers (the patch has nothing on its bottom but plated pads), and R1 and J1.
	for (const name of ["Board", "Top Copper", "Plated Holes", "Top Solder Mask", "Top Silkscreen", "R1", "J1"]) expect(names).toContain(name)
	for (const name of names) if (!["R1", "J1"].includes(name!)) expect(Object.keys(layerColours(board.colors))).toContain(name)
})

test("every part is named apart: the board's own by their geometry, a model by its file", () => {
	const models = new Map<string, Uint8Array | null>()
	for (const m of Object.values(SAMPLE_MODELS)) models.set(m.key, new Uint8Array(readFileSync(fileURLToPath(m.url))))
	const products = (viaHoles: boolean) => {
		const text = new TextDecoder("latin1").decode(exportStep(scene, board, models, "Preview", { ...DEFAULT_STEP_OPTIONS, onePart: false, viaHoles }).bytes)
		return [...text.matchAll(/=PRODUCT\('((?:[^']|'')*)','((?:[^']|'')*)'/g)].map(m => m[2]!)
	}
	const plain = products(false), drilled = products(true)
	// No two products in a file named alike; the same export names them the same every time.
	expect(new Set(plain).size).toBe(plain.length)
	expect(products(false)).toEqual(plain)
	const own = (names: string[]) => names.filter(n => /^(Board|Top|Bottom|Plated) /.test(n))
	const fromModels = (names: string[]) => names.filter(n => !own(names).includes(n) && n !== "Preview")
	expect(own(plain).length).toBeGreaterThanOrEqual(5)
	for (const n of [...own(plain), ...fromModels(plain)]) expect(n).toMatch(/ [0-9a-f]{6}$/)
	// The vias drilled make another board: its parts are named otherwise. The models are the same files
	// and keep their names.
	expect(own(drilled).filter(n => own(plain).includes(n))).toEqual([])
	expect(fromModels(drilled)).toEqual(fromModels(plain))
})

test("as one part: one product, no assembly, every model's bodies copied in place and named by designator", async () => {
	const models = new Map<string, Uint8Array | null>()
	for (const m of Object.values(SAMPLE_MODELS)) models.set(m.key, new Uint8Array(readFileSync(fileURLToPath(m.url))))
	const one = exportStep(scene, board, models, "Preview", DEFAULT_STEP_OPTIONS)
	const text = new TextDecoder("latin1").decode(one.bytes)
	expect(one.parts).toBe(2)
	expect(one.missing).toEqual([])
	expect(text.match(/=PRODUCT\(/g)).toHaveLength(1)
	expect(text).not.toMatch(/NEXT_ASSEMBLY_USAGE_OCCURRENCE|CONTEXT_DEPENDENT_SHAPE_REPRESENTATION/)
	expect(text).not.toMatch(/MAPPED_ITEM|REPRESENTATION_MAP/)
	expect(text).toMatch(/=MANIFOLD_SOLID_BREP\('R1'/)
	expect(text).toMatch(/=MANIFOLD_SOLID_BREP\('J1'/)
	// Read back: the same bodies as the assembly, in the same places.
	const occt = await occtFactory()
	const extent = (bytes: Uint8Array) => {
		const r = occt.ReadStepFile(bytes, { linearUnit: "millimeter" })
		expect(r.success).toBe(true)
		const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
		for (const m of r.meshes) {
			const p = m.attributes.position.array as number[]
			for (let i = 0; i < p.length; i++) {
				lo[i % 3] = Math.min(lo[i % 3]!, p[i]!)
				hi[i % 3] = Math.max(hi[i % 3]!, p[i]!)
			}
		}
		return { meshes: r.meshes.length, box: [...lo, ...hi].map(v => Math.round(v * 1000) / 1000) }
	}
	const asm = extent(exportStep(scene, board, models, "Preview", { ...DEFAULT_STEP_OPTIONS, onePart: false }).bytes)
	expect(extent(one.bytes)).toEqual(asm)
})
