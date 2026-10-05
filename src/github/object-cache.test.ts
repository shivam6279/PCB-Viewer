import "fake-indexeddb/auto"
import { expect, test } from "vitest"
import { idbObjectCache } from "./object-cache"

let n = 0
const fresh = (capBytes = 1000) => idbObjectCache({ dbName: `test-${++n}`, capBytes })

test("stores and returns blobs by sha", async () => {
	const c = fresh()
	expect(await c.getBlob("a")).toBeUndefined()
	await c.putBlob("a", new Uint8Array([1, 2]))
	expect(await c.getBlob("a")).toEqual(new Uint8Array([1, 2]))
})

test("stores JSON values by key", async () => {
	const c = fresh()
	await c.putJson("tree:abc", { paths: ["x"] })
	expect(await c.getJson("tree:abc")).toEqual({ paths: ["x"] })
	expect(await c.getJson("tree:nope")).toBeUndefined()
})

test("evicts the least recently used blobs past the cap", async () => {
	const c = fresh(1000)
	await c.putBlob("old", new Uint8Array(400))
	await c.putBlob("mid", new Uint8Array(400))
	await c.getBlob("old") // now "mid" is the least recently used
	await c.putBlob("new", new Uint8Array(400))
	expect(await c.getBlob("mid")).toBeUndefined()
	expect(await c.getBlob("old")).toBeDefined()
	expect(await c.getBlob("new")).toBeDefined()
})

test("the running total survives reopening the database", async () => {
	const name = `test-${++n}`
	const a = idbObjectCache({ dbName: name, capBytes: 1000 })
	await a.putBlob("one", new Uint8Array(600))
	const b = idbObjectCache({ dbName: name, capBytes: 1000 })
	await b.putBlob("two", new Uint8Array(600))
	expect(await b.getBlob("one")).toBeUndefined()
	expect(await b.getBlob("two")).toBeDefined()
})

test("serves as an ETag store", async () => {
	const c = fresh()
	await c.etags.set("https://x", { etag: '"e"', body: { a: 1 } })
	expect(await c.etags.get("https://x")).toEqual({ etag: '"e"', body: { a: 1 } })
})
