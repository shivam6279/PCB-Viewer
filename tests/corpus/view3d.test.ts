import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import * as THREE from "three"
import occtFactory from "occt-import-js"
import { parseAltiumFile } from "altiumts"
import { CORPUS, hasCorpus, listCorpusDocs } from "./env"
import { extractBoard3d } from "../../src/3d/board3d"
import { buildBoardGeometry } from "../../src/3d/board-geometry"
import { buildPcbScene } from "../../src/pcb/scene"
import { bodyMatrix } from "../../src/3d/components"
import { MM } from "../../src/3d/frame"

const CUBLI = join(CORPUS, "Cubli/Main Board/STM32/Cubli.PcbDoc")

describe.skipIf(!hasCorpus)("3D board data", () => {
	test("every board yields its thickness, colours and component bodies", () => {
		for (const path of listCorpusDocs().filter(p => /\.pcbdoc$/i.test(p))) {
			let doc
			try {
				doc = parseAltiumFile(new Uint8Array(readFileSync(path))).document as any
			} catch {
				continue // boards altiumts cannot parse are covered by parse-all
			}
			const b = extractBoard3d(doc)
			expect(b.thickness, path).toBeGreaterThan(0) // LedFlex is a 1.9 mil flex strip
			for (const body of b.bodies) if (body.model) expect(b.models.some(m => m.key === body.model), path).toBe(true)
		}
	})

	test("every board builds as layered 3D geometry", () => {
		const slow: string[] = []
		for (const path of listCorpusDocs().filter(p => /.pcbdoc$/i.test(p))) {
			let doc
			try {
				doc = parseAltiumFile(new Uint8Array(readFileSync(path))).document as any
			} catch {
				continue
			}
			const started = performance.now()
			const g = buildBoardGeometry(buildPcbScene(doc), extractBoard3d(doc))
			const ms = performance.now() - started
			if (ms > 15_000) slow.push(`${path} ${ms.toFixed(0)} ms`)
			expect(g.meshes.some(m => m.role === "dielectric"), path).toBe(true)
			expect(g.meshes.some(m => m.role === "copper"), path).toBe(true)
			for (const m of g.meshes) expect(m.positions.every(Number.isFinite), path).toBe(true)
		}
		expect(slow).toEqual([])
	})

	// Oracle: each body record carries the outline and height Altium computed from its placed model.
	test("Cubli: every STEP model, placed by Altium's rule, covers its body's outline and height", async () => {
		const doc = parseAltiumFile(new Uint8Array(readFileSync(CUBLI))).document as any
		const board = extractBoard3d(doc)
		const occt = await occtFactory()
		const points = new Map<string, number[]>()
		const frame = { cx: 0, cy: 0, thickness: board.thickness * MM }
		let checked = 0
		const misses: string[] = []
		for (const b of board.bodies) {
			if (!b.model) continue
			if (!points.has(b.model)) {
				const r = occt.ReadStepFile(await doc.embeddedModels[Number(b.model)].getDecompressedBytes(), { linearUnit: "millimeter" })
				const p: number[] = []
				for (const m of r.meshes) p.push(...m.attributes.position.array)
				points.set(b.model, p)
			}
			const m = bodyMatrix(b, frame)
			const box = new THREE.Box3()
			const p = points.get(b.model)!
			const v = new THREE.Vector3()
			for (let i = 0; i < p.length; i += 3) box.expandByPoint(v.set(p[i]!, p[i + 1]!, p[i + 2]!).applyMatrix4(m))
			const ring = b.contour[0]!
			const xs = ring.filter((_, i) => i % 2 === 0).map(x => x * MM), ys = ring.filter((_, i) => i % 2 === 1).map(y => y * MM)
			const xy = Math.max(Math.abs(box.min.x - Math.min(...xs)), Math.abs(box.max.x - Math.max(...xs)), Math.abs(box.min.y - Math.min(...ys)), Math.abs(box.max.y - Math.max(...ys)))
			const top = b.side === "top" ? box.max.z : -frame.thickness - box.min.z
			const z = Math.abs(top - b.height * MM)
			checked++
			// 0.3 mm: some outlines are sampled coarser than the model (Cubli's worst: 0.25 mm, U8).
			if (xy > 0.3 || z > 0.08) misses.push(`${doc.components[b.component!]?.designator} xy ${xy.toFixed(2)} z ${z.toFixed(2)}`)
		}
		expect(checked).toBe(441)
		expect(misses).toEqual([])
	})
})
