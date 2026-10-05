import type { EtagStore } from "./client"

// Git objects never change, so anything keyed by a sha is cached forever (bar LRU eviction of blobs
// past the size cap). Neighbouring commits share most blobs, so a second commit downloads only what
// changed. Also holds JSON (trees by commit sha, discovery results) and the client's ETags.
export interface ObjectCache {
	getBlob(sha: string): Promise<Uint8Array | undefined>
	putBlob(sha: string, bytes: Uint8Array): Promise<void>
	getJson<T>(key: string): Promise<T | undefined>
	putJson(key: string, value: unknown): Promise<void>
	readonly etags: EtagStore
}

interface BlobMeta {
	sha: string
	size: number
	used: number
}

const BLOBS = "blobs"
const META = "blobMeta"
const JSON_STORE = "json"
const ETAGS = "etags"

export function idbObjectCache(opts: { dbName?: string; capBytes?: number } = {}): ObjectCache {
	const cap = opts.capBytes ?? 1024 ** 3
	const dbp = openDb(opts.dbName ?? "pcb-viewer-github")
	let total: Promise<number> | null = null
	let clock = 0
	const now = () => Math.max(Date.now(), ++clock) // strictly increasing, so LRU order is exact

	const tx = async (stores: string[], mode: IDBTransactionMode) => (await dbp).transaction(stores, mode)

	const loadTotal = async () => {
		const metas = await request<BlobMeta[]>((await tx([META], "readonly")).objectStore(META).getAll())
		return metas.reduce((s, m) => s + m.size, 0)
	}

	async function evict(): Promise<void> {
		let sum = await (total ??= loadTotal())
		if (sum <= cap) return
		const t = await tx([BLOBS, META], "readwrite")
		const target = cap * 0.9
		await new Promise<void>((resolve, reject) => {
			const cur = t.objectStore(META).index("used").openCursor()
			cur.onsuccess = () => {
				const c = cur.result
				if (!c || sum <= target) return resolve()
				const m = c.value as BlobMeta
				t.objectStore(BLOBS).delete(m.sha)
				c.delete()
				sum -= m.size
				c.continue()
			}
			cur.onerror = () => reject(cur.error)
		})
		await done(t)
		total = Promise.resolve(sum)
	}

	const json = (store: string) => ({
		async get<T>(key: string) {
			return (await request<T | undefined>((await tx([store], "readonly")).objectStore(store).get(key))) ?? undefined
		},
		async put(key: string, value: unknown) {
			const t = await tx([store], "readwrite")
			t.objectStore(store).put(value, key)
			await done(t)
		},
	})
	const jsonStore = json(JSON_STORE)
	const etagStore = json(ETAGS)

	return {
		async getBlob(sha) {
			const t = await tx([BLOBS, META], "readwrite")
			const bytes = await request<Uint8Array | undefined>(t.objectStore(BLOBS).get(sha))
			if (bytes) t.objectStore(META).put({ sha, size: bytes.byteLength, used: now() } satisfies BlobMeta)
			await done(t)
			return bytes ?? undefined
		},
		async putBlob(sha, bytes) {
			const before = await (total ??= loadTotal())
			const t = await tx([BLOBS, META], "readwrite")
			const existed = await request<BlobMeta | undefined>(t.objectStore(META).get(sha))
			t.objectStore(BLOBS).put(bytes, sha)
			t.objectStore(META).put({ sha, size: bytes.byteLength, used: now() } satisfies BlobMeta)
			await done(t)
			total = Promise.resolve(before - (existed?.size ?? 0) + bytes.byteLength)
			await evict()
		},
		getJson: key => jsonStore.get(key),
		putJson: (key, value) => jsonStore.put(key, value),
		etags: { get: url => etagStore.get(url), set: (url, e) => etagStore.put(url, e) },
	}
}

// For tests and browsers without IndexedDB (some private modes).
export function memoryObjectCache(): ObjectCache {
	const blobs = new Map<string, Uint8Array>()
	const json = new Map<string, unknown>()
	const etags = new Map<string, unknown>()
	return {
		getBlob: async sha => blobs.get(sha),
		putBlob: async (sha, b) => void blobs.set(sha, b),
		getJson: async <T>(k: string) => json.get(k) as T | undefined,
		putJson: async (k, v) => void json.set(k, v),
		etags: { get: async url => etags.get(url) as never, set: async (url, e) => void etags.set(url, e) },
	}
}

function openDb(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(name, 1)
		req.onupgradeneeded = () => {
			const db = req.result
			db.createObjectStore(BLOBS)
			db.createObjectStore(META, { keyPath: "sha" }).createIndex("used", "used")
			db.createObjectStore(JSON_STORE)
			db.createObjectStore(ETAGS)
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
}

function request<T>(req: IDBRequest): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result as T)
		req.onerror = () => reject(req.error)
	})
}

function done(t: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		t.oncomplete = () => resolve()
		t.onerror = () => reject(t.error)
		t.onabort = () => reject(t.error)
	})
}
