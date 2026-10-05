// STEP file -> triangle mesh, with the model's own face colours, in a worker (OpenCascade WASM via
// occt-import-js). Lengths come back in mm.
import { expose, transfer } from "comlink"
import occtFactory from "occt-import-js"
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url"
import type { StepMesh } from "./step-mesh"
import { stepStyles } from "./step-styles"

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

let occt: Promise<any> | null = null
const load = () => (occt ??= occtFactory({ locateFile: () => wasmUrl }))

async function convert(bytes: Uint8Array): Promise<StepMesh | null> {
	const o = await load()
	const r = o.ReadStepFile(bytes, { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 })
	if (!r?.success) return null
	let vertices = 0, indices = 0
	for (const m of r.meshes) {
		vertices += m.attributes.position.array.length / 3
		indices += m.index.array.length
	}
	const positions = new Float32Array(vertices * 3)
	const normals = new Float32Array(vertices * 3)
	const colors = new Uint8Array(vertices * 4) // alpha 0 = no colour in the file: use the body's
	const index = new Uint32Array(indices)
	// Solid colours come from the file's text (StepStyles: the importer misses some files' styles and
	// resolves part-vs-solid colours inconsistently), mapped by solid and face order when the
	// shapes agree. occt-import-js reports colours linearised; the file's own values are sRGB.
	const styles = stepStyles(new TextDecoder().decode(bytes))
	const lin = (c: number[] | null | undefined) => (c ? c.map(srgbToLinear) : undefined)
	const matches = styles !== null && styles.solids.length === r.meshes.length
	const solidColour = (meshIndex: number, m: any) =>
		(matches ? lin(styles!.solids[meshIndex]!.color) : undefined) ?? m.color ?? (styles?.colors.length === 1 ? lin(styles.colors[0]) : undefined)
	const faceColour = (meshIndex: number, faceIndex: number, m: any) => {
		const faces = matches ? styles!.solids[meshIndex]!.faces : null
		return faces && faces.length === (m.brep_faces ?? []).length ? lin(faces[faceIndex]) : undefined
	}
	let v = 0, i = 0
	for (const [meshIndex, m] of (r.meshes as any[]).entries()) {
		const p = m.attributes.position.array as number[]
		const n = m.attributes.normal?.array as number[] | undefined
		positions.set(p, v * 3)
		if (n) normals.set(n, v * 3)
		const count = p.length / 3
		const paint = (from: number, to: number, c: number[] | undefined) => {
			if (!c) return
			for (let k = from; k < to; k++) colors.set([c[0]! * 255, c[1]! * 255, c[2]! * 255, 255], (v + k) * 4)
		}
		paint(0, count, solidColour(meshIndex, m))
		const idx = m.index.array as number[]
		for (let k = 0; k < idx.length; k++) index[i + k] = idx[k]! + v
		// Per-face colours override the mesh colour: paint the vertices of each face's triangles.
		for (const [faceIndex, f] of ((m.brep_faces ?? []) as any[]).entries()) {
			const color = f.color ?? faceColour(meshIndex, faceIndex, m)
			if (!color) continue
			for (let t = f.first; t <= f.last; t++) for (let c = 0; c < 3; c++) paint(idx[t * 3 + c]!, idx[t * 3 + c]! + 1, color)
		}
		v += count
		i += idx.length
	}
	return { positions, normals, colors, index }
}

const api = {
	async convert(bytes: Uint8Array) {
		const mesh = await convert(bytes)
		return mesh ? transfer(mesh, [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.index.buffer]) : null
	},
}
export type StepWorkerApi = typeof api
expose(api)
