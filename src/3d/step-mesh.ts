// A converted STEP model and where it comes from: the board's embedded files, converted in a small
// pool of workers, each distinct file once (boards embed the same file many times), and cached in
// IndexedDB by content hash so a reopened board shows its parts at once.
import { wrap, type Remote } from "comlink"
import { get, set } from "idb-keyval"
import type { StepWorkerApi } from "./step.worker"

export interface StepMesh {
	positions: Float32Array // mm
	normals: Float32Array
	colors: Uint8Array // rgba per vertex; alpha 0 = no colour in the file
	index: Uint32Array
}

const CACHE_VERSION = 6
const pool: Remote<StepWorkerApi>[] = []
let next = 0
const POOL_SIZE = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1))

function worker(): Remote<StepWorkerApi> {
	if (pool.length < POOL_SIZE) pool.push(wrap<StepWorkerApi>(new Worker(new URL("./step.worker.ts", import.meta.url), { type: "module" })))
	return pool[next++ % pool.length]!
}

async function hash(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>)
	return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")
}

const inFlight = new Map<string, Promise<StepMesh | null>>()

// One STEP file as a mesh: from the cache, or converted (and cached).
export async function stepMesh(bytes: Uint8Array): Promise<StepMesh | null> {
	const key = `step:${CACHE_VERSION}:${await hash(bytes)}`
	let pending = inFlight.get(key)
	if (!pending) {
		pending = (async () => {
			try {
				const cached = await get<StepMesh>(key)
				if (cached) return cached
			} catch {
				// No IndexedDB (private window): convert every time.
			}
			const mesh = await worker().convert(bytes)
			if (mesh) set(key, mesh).catch(() => {})
			return mesh
		})()
		inFlight.set(key, pending)
	}
	return pending
}
