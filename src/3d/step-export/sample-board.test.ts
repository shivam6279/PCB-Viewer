import { readFileSync } from "node:fs"
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

test("the preview board exports every layer and both parts, each layer under its colour's name", () => {
	const models = new Map<string, Uint8Array | null>()
	for (const m of Object.values(SAMPLE_MODELS)) models.set(m.key, new Uint8Array(readFileSync(fileURLToPath(m.url))))
	const { bytes, parts, missing } = exportStep(scene, board, models, "Preview", { ...DEFAULT_STEP_OPTIONS, copperUnderMask: true })
	expect(parts).toBe(2)
	expect(missing).toEqual([])
	const names = [...new TextDecoder("latin1").decode(bytes).matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('\d+','([^']*)'/g)].map(m => m[1])
	// The board's top layers (the patch has nothing on its bottom but plated pads), and R1 and J1.
	for (const name of ["Board", "Top Copper", "Plated Holes", "Top Solder Mask", "Top Silkscreen", "R1", "J1"]) expect(names).toContain(name)
	for (const name of names) if (!["R1", "J1"].includes(name!)) expect(Object.keys(layerColours(board.colors))).toContain(name)
})
