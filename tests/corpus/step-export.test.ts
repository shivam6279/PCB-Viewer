import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import occtFactory from "occt-import-js"
import { parseAltiumFile } from "altiumts"
import { CORPUS, hasCorpus, listCorpusDocs } from "./env"
import { extractBoard3d, stepBytes } from "../../src/3d/board3d"
import { buildPcbScene } from "../../src/pcb/scene"
import { outerLayers } from "../../src/3d/board-geometry"
import { estimateStep, exportStep } from "../../src/3d/step-export/export-step"
import { DEFAULT_STEP_OPTIONS, estimateBytes, type StepExportOptions } from "../../src/3d/step-export/options"

async function exportBoard(path: string, options: StepExportOptions = DEFAULT_STEP_OPTIONS) {
	const doc = parseAltiumFile(new Uint8Array(readFileSync(path))).document as any
	const scene = buildPcbScene(doc)
	const board = extractBoard3d(doc)
	const models = new Map<string, Uint8Array | null>()
	for (const m of board.models) models.set(m.key, await stepBytes(doc, m.key))
	return { board, result: exportStep(scene, board, models, "board", options) }
}

describe.skipIf(!hasCorpus)("STEP export", () => {
	test("every board exports with every part placed: its model, or its outline where the model is not STEP", async () => {
		const missing: string[] = []
		for (const path of listCorpusDocs().filter(p => /\.pcbdoc$/i.test(p))) {
			let out, asm
			try {
				out = await exportBoard(path)
				asm = await exportBoard(path, { ...DEFAULT_STEP_OPTIONS, onePart: false })
			} catch (e) {
				if (String(e).includes("parse")) continue // boards altiumts cannot parse are covered by parse-all
				throw e
			}
			const placed = out.board.bodies.filter(b => b.model || (b.contour[0]?.length ?? 0) >= 6).length
			// As one part: one product, nothing placed as a part of its own, every model's bodies copied in.
			// (Counted in the bytes: a board of a thousand LEDs makes a file too big for one string.)
			const bytes = Buffer.from(out.result.bytes.buffer, out.result.bytes.byteOffset, out.result.bytes.byteLength)
			const count = (needle: string) => {
				let n = 0
				for (let i = bytes.indexOf(needle); i >= 0; i = bytes.indexOf(needle, i + needle.length)) n++
				return n
			}
			expect(bytes.subarray(0, 13).toString("latin1"), path).toBe("ISO-10303-21;")
			expect(count("=PRODUCT("), path).toBe(1)
			expect([count("NEXT_ASSEMBLY_USAGE_OCCURRENCE"), count("MAPPED_ITEM"), count("REPRESENTATION_MAP")], path).toEqual([0, 0, 0])
			expect(out.result.parts, path).toBe(placed)
			// As an assembly: an instance for the board and for every part.
			const asmText = new TextDecoder("latin1").decode(asm.result.bytes)
			expect(asmText.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g)?.length ?? 0, path).toBeGreaterThanOrEqual(asm.result.parts + 1)
			expect(asm.result.parts, path).toBe(placed)
			missing.push(...out.result.missing)
		}
		// The models that are not STEP at all: native SolidWorks parts and a Parasolid file.
		expect(missing.every(m => /\.(sldprt|x_t)$/i.test(m)), missing.join(", ")).toBe(true)
	}, 600_000)

	test("a board reads back: the board solid and every part", async () => {
		const { result } = await exportBoard(join(CORPUS, "PnP/Camera/Camera.PcbDoc"))
		const occt = await occtFactory()
		const r = occt.ReadStepFile(result.bytes, { linearUnit: "millimeter" })
		expect(r.success).toBe(true)
		// The board plus at least one mesh per part.
		expect(r.meshes.length).toBeGreaterThan(result.parts)
	}, 600_000)

	test("every combination of settings exports just the layers it asks for", async () => {
		const doc = parseAltiumFile(new Uint8Array(readFileSync(join(CORPUS, "PnP/Camera/Camera.PcbDoc")))).document as any
		const scene = buildPcbScene(doc)
		const board = extractBoard3d(doc)
		const occt = await occtFactory()
		for (let bits = 0; bits < 64; bits++) {
			const bit = (i: number) => (bits & (1 << i)) !== 0
			const [copper, copperUnderMask, platedHoles, mask, silkscreen, viaHoles] = [bit(0), bit(1), bit(2), bit(3), bit(4), bit(5)]
			if (copperUnderMask && !(copper && mask)) continue
			const o: StepExportOptions = { onePart: false, parts: false, copper, copperUnderMask, platedHoles, mask, maskOneFace: true, silkscreen, viaHoles, quality: "standard" }
			const { bytes } = exportStep(scene, board, new Map(), "Camera", o)
			const names = [...new TextDecoder("latin1").decode(bytes).matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('\d+','([^']*)'/g)].map(m => m[1]).sort()
			const want = ["Board", ...(copper ? ["Top Copper", "Bottom Copper"] : []), ...(platedHoles ? ["Plated Holes"] : []), ...(mask ? ["Top Solder Mask", "Bottom Solder Mask"] : []), ...(silkscreen ? ["Top Silkscreen", "Bottom Silkscreen"] : [])].sort()
			expect(names, JSON.stringify(o)).toEqual(want)
			expect(occt.ReadStepFile(bytes, null).success, JSON.stringify(o)).toBe(true)
		}
	}, 600_000)

	test("the size estimate is close to the file each setting makes; finer curves make a bigger file", async () => {
		const doc = parseAltiumFile(new Uint8Array(readFileSync(join(CORPUS, "PnP/Camera/Camera.PcbDoc")))).document as any
		const scene = buildPcbScene(doc)
		const board = extractBoard3d(doc)
		const models = new Map<string, Uint8Array | null>()
		for (const m of board.models) models.set(m.key, await stepBytes(doc, m.key))
		const t0 = performance.now()
		const estimate = estimateStep(scene, board, models, DEFAULT_STEP_OPTIONS.quality)
		const ms = performance.now() - t0
		const cases: Partial<StepExportOptions>[] = [{}, { parts: false }, { copperUnderMask: true }, { mask: false }, { viaHoles: true }, { silkscreen: false, platedHoles: false }, { copper: false, copperUnderMask: false }, { quality: "draft" }, { quality: "standard" }]
		const sizes: Record<string, number> = {}
		for (const c of cases) {
			const o = { ...DEFAULT_STEP_OPTIONS, ...c }
			const e = o.quality === DEFAULT_STEP_OPTIONS.quality ? estimate : estimateStep(scene, board, models, o.quality, estimate.parts)
			const actual = exportStep(scene, board, models, "Camera", o).bytes.length
			sizes[JSON.stringify(c)] = actual
			const guess = estimateBytes(e, o)
			console.log(JSON.stringify(c), actual, guess, (guess / actual).toFixed(3))
			expect(Math.abs(guess / actual - 1), JSON.stringify(c)).toBeLessThan(0.1)
		}
		console.log("estimate ms", Math.round(ms))
		// Fine (the default) is the biggest.
		expect(DEFAULT_STEP_OPTIONS.quality).toBe("fine")
		expect(sizes['{"quality":"draft"}']).toBeLessThan(sizes['{"quality":"standard"}']!)
		expect(sizes['{"quality":"standard"}']).toBeLessThan(sizes["{}"]!)
	}, 600_000)

	test("a round board's edge is true arcs: cylinders CAD can mate to, not facets", async () => {
		const doc = parseAltiumFile(new Uint8Array(readFileSync(join(CORPUS, "PnP/LED_ring/led_ring.PcbDoc")))).document as any
		const scene = buildPcbScene(doc)
		const board = extractBoard3d(doc)
		const { bytes } = exportStep(scene, board, new Map(), "led_ring", { ...DEFAULT_STEP_OPTIONS, parts: false, copper: false, mask: false, silkscreen: false, platedHoles: false })
		const text = new TextDecoder("latin1").decode(bytes)
		// Its outline: four quarter arcs of one 551.2 mil circle, written as one circle: one cylinder (its
		// two half walls share it).
		const radii = [...text.matchAll(/CYLINDRICAL_SURFACE\('',#\d+,([\d.]+)\)/g)].map(m => Number(m[1]))
		expect(radii.filter(r => Math.abs(r - 551.2 * 0.0254) < 1e-3).length).toBe(1)
		const occt = await occtFactory()
		const r = occt.ReadStepFile(bytes, { linearUnit: "millimeter" })
		expect(r.success).toBe(true)
		expect(r.meshes.length).toBe(1)
	}, 120_000)

	test("each solder mask is one face, or tiles when asked (quicker for CAD to read)", () => {
		const doc = parseAltiumFile(new Uint8Array(readFileSync(join(CORPUS, "Cubli/Main Board/STM32/Cubli.PcbDoc")))).document as any
		const scene = buildPcbScene(doc)
		const board = extractBoard3d(doc)
		const whole = outerLayers(scene, board, { viaHoles: false, exposedOnly: true, wholeMask: true })
		expect([whole.mask.top.length, whole.mask.bottom.length]).toEqual([1, 1])
		const tiled = outerLayers(scene, board, { viaHoles: false, exposedOnly: true, wholeMask: false })
		expect(tiled.mask.top.length).toBeGreaterThan(1)
		expect(tiled.mask.bottom.length).toBeGreaterThan(1)
		// The copper is the same either way.
		expect(tiled.copper.top.length).toBe(whole.copper.top.length)
	}, 120_000)

	test("boards exported for one assembly never name two different parts alike", async () => {
		const files = ["PnP/Camera/Camera.PcbDoc", "PnP/Deserializer/deserializer.PcbDoc", "PnP/LED_ring/led_ring.PcbDoc", "PnP/PnP/PnP.PcbDoc"]
		const seen = new Map<string, string>() // a board layer's part name -> its board
		for (const file of files) {
			const { result } = await exportBoard(join(CORPUS, file), { ...DEFAULT_STEP_OPTIONS, onePart: false })
			const names = [...new TextDecoder("latin1").decode(result.bytes).matchAll(/=PRODUCT\('(?:[^']|'')*','((?:[^']|'')*)'/g)].map(m => m[1]!)
			expect(new Set(names).size, file).toBe(names.length)
			for (const name of names.filter(n => /^(Board|Top|Bottom|Plated) /.test(n))) {
				expect(seen.get(name), `${name} in ${file}`).toBeUndefined()
				seen.set(name, file)
			}
		}
		expect(seen.size).toBeGreaterThanOrEqual(4 * 5)
	}, 600_000)
})
