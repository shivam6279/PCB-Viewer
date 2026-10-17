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

// A STEP file read by occt, with each face's colour: occt's own, else the file's styles read from its
// text (StepStyles: the importer misses some files' styles and resolves part-vs-solid colours
// inconsistently), mapped by solid and face order when the shapes agree. occt-import-js reports
// colours linearised; the file's own values are sRGB.
async function read(bytes: Uint8Array) {
	const o = await load()
	const r = o.ReadStepFile(bytes, { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 })
	if (!r?.success) return null
	const styles = stepStyles(new TextDecoder().decode(bytes))
	const matches = styles !== null && styles.solids.length === r.meshes.length
	const meshes = r.meshes as any[]
	// A mesh's colour, and its faces' (undefined: none of their own).
	const meshColour = (meshIndex: number): number[] | undefined =>
		(matches ? lin(styles!.solids[meshIndex]!.color) : undefined) ?? meshes[meshIndex].color ?? (styles?.colors.length === 1 ? lin(styles.colors[0]) : undefined)
	const faceColour = (meshIndex: number, faceIndex: number): number[] | undefined => {
		const f = (meshes[meshIndex].brep_faces ?? [])[faceIndex]
		if (f?.color) return f.color
		const faces = matches ? styles!.solids[meshIndex]!.faces : null
		return faces && faces.length === (meshes[meshIndex].brep_faces ?? []).length ? lin(faces[faceIndex]) : undefined
	}
	return { root: r.root, meshes, meshColour, faceColour }
}
const lin = (c: number[] | null | undefined) => (c ? c.map(srgbToLinear) : undefined)
type Read = NonNullable<Awaited<ReturnType<typeof read>>>

// Meshes into one StepMesh, each painted by colourOf (mesh-wide) and faceOf (per face, over it).
function merge(meshes: any[], colourOf: (m: number) => number[] | undefined, faceOf: (m: number, f: number) => number[] | undefined): StepMesh {
	let vertices = 0, indices = 0
	for (const m of meshes) {
		vertices += m.attributes.position.array.length / 3
		indices += m.index.array.length
	}
	const positions = new Float32Array(vertices * 3)
	const normals = new Float32Array(vertices * 3)
	const colors = new Uint8Array(vertices * 4) // alpha 0 = no colour in the file: use the body's
	const index = new Uint32Array(indices)
	let v = 0, i = 0
	for (const [meshIndex, m] of meshes.entries()) {
		const p = m.attributes.position.array as number[]
		const n = m.attributes.normal?.array as number[] | undefined
		positions.set(p, v * 3)
		if (n) normals.set(n, v * 3)
		const count = p.length / 3
		const paint = (from: number, to: number, c: number[] | undefined) => {
			if (!c) return
			for (let k = from; k < to; k++) colors.set([c[0]! * 255, c[1]! * 255, c[2]! * 255, 255], (v + k) * 4)
		}
		paint(0, count, colourOf(meshIndex))
		const idx = m.index.array as number[]
		for (let k = 0; k < idx.length; k++) index[i + k] = idx[k]! + v
		// Per-face colours override the mesh colour: paint the vertices of each face's triangles.
		for (const [faceIndex, f] of ((m.brep_faces ?? []) as any[]).entries()) {
			const color = faceOf(meshIndex, faceIndex)
			if (!color) continue
			for (let t = f.first; t <= f.last; t++) for (let c = 0; c < 3; c++) paint(idx[t * 3 + c]!, idx[t * 3 + c]! + 1, color)
		}
		v += count
		i += idx.length
	}
	return { positions, normals, colors, index }
}

async function convert(bytes: Uint8Array): Promise<StepMesh | null> {
	const r = await read(bytes)
	return r && merge(r.meshes, r.meshColour, r.faceColour)
}

// The part models an assembly embeds, read once (the preview sends the same few every time).
const models = new Map<string, Promise<Read | null>>()
function readModel(bytes: Uint8Array) {
	let sum = 0
	for (let k = 0; k < bytes.length; k += 61) sum = (sum * 31 + bytes[k]!) | 0
	const key = `${bytes.length}:${sum}`
	if (!models.has(key)) models.set(key, read(bytes))
	return models.get(key)!
}

// An assembly the STEP export wrote (the export dialog's preview board), with the colours occt loses
// reading it whole: each of its layers (a part named in layers, with its colour as written, sRGB) in
// that colour, and each embedded model's faces in the colours of that model read on its own, matched
// by face count (the export copies a model whole).
async function convertAssembly(bytes: Uint8Array, layers: Record<string, number[]>, models: Uint8Array[]): Promise<StepMesh | null> {
	const r = await read(bytes)
	if (!r) return null
	const own = (await Promise.all(models.map(readModel))).filter((m): m is Read => m !== null)
	const layerOf = new Map<number, number[]>()
	const walk = (node: any, colour: number[] | undefined) => {
		const c = (node.name && layers[node.name] ? lin(layers[node.name]) : undefined) ?? colour
		for (const m of node.meshes ?? []) if (c) layerOf.set(m, c)
		for (const child of node.children ?? []) walk(child, c)
	}
	walk(r.root, undefined)
	// Each model mesh's counterpart in the model files: the same number of faces.
	const source = r.meshes.map(m => {
		const faces = (m.brep_faces ?? []).length
		for (const o of own) {
			const k = o.meshes.findIndex(x => (x.brep_faces ?? []).length === faces)
			if (k >= 0) return { o, k }
		}
		return null
	})
	return merge(
		r.meshes,
		m => layerOf.get(m) ?? r.meshColour(m) ?? (source[m] ? source[m].o.meshColour(source[m].k) : undefined),
		(m, f) => (layerOf.has(m) ? undefined : (r.faceColour(m, f) ?? (source[m] ? source[m].o.faceColour(source[m].k, f) : undefined))),
	)
}

const api = {
	async convert(bytes: Uint8Array) {
		const mesh = await convert(bytes)
		return mesh ? transfer(mesh, [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.index.buffer]) : null
	},
	async convertAssembly(bytes: Uint8Array, layers: Record<string, number[]>, models: Uint8Array[]) {
		const mesh = await convertAssembly(bytes, layers, models)
		return mesh ? transfer(mesh, [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.index.buffer]) : null
	},
}
export type StepWorkerApi = typeof api
expose(api)
