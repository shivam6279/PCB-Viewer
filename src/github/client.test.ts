import { expect, test } from "vitest"
import { createClient, GitHubError, memoryEtagStore } from "./client"

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function fakeFetch(handler: Handler) {
	const calls: { url: string; headers: Record<string, string> }[] = []
	const fn = async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = String(input)
		calls.push({ url, headers: { ...(init.headers as Record<string, string>) } })
		return handler(url, init)
	}
	return { fn: fn as typeof fetch, calls }
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

test("sends the token and API version headers", async () => {
	const f = fakeFetch(() => json({ login: "me" }))
	const client = createClient({ token: "tok", fetch: f.fn })
	expect(await client.json("/user")).toEqual({ login: "me" })
	expect(f.calls[0]!.url).toBe("https://api.github.com/user")
	expect(f.calls[0]!.headers.Authorization).toBe("Bearer tok")
	expect(f.calls[0]!.headers["X-GitHub-Api-Version"]).toBe("2022-11-28")
})

test("revalidates with the stored ETag and reuses the body on 304", async () => {
	let n = 0
	const f = fakeFetch((_, init) => {
		n++
		const inm = (init.headers as Record<string, string>)["If-None-Match"]
		return inm === '"v1"' ? new Response(null, { status: 304 }) : json({ v: 1 }, { etag: '"v1"' })
	})
	const client = createClient({ token: "t", fetch: f.fn, etags: memoryEtagStore() })
	expect(await client.json("/repos/a/b")).toEqual({ v: 1 })
	expect(await client.json("/repos/a/b")).toEqual({ v: 1 })
	expect(n).toBe(2)
	expect(f.calls[1]!.headers["If-None-Match"]).toBe('"v1"')
})

test("follows Link rel=next across pages", async () => {
	const f = fakeFetch(url =>
		url.includes("&page=2")
			? json([3])
			: json([1, 2], { link: '<https://api.github.com/user/repos?per_page=2&page=2>; rel="next", <https://api.github.com/user/repos?per_page=2&page=2>; rel="last"' }),
	)
	const client = createClient({ token: "t", fetch: f.fn })
	expect(await client.pages<number>("/user/repos?per_page=2")).toEqual([1, 2, 3])
})

test("pages() stops at maxPages and reports the next url", async () => {
	const f = fakeFetch(() => json([1], { link: '<https://api.github.com/x?page=2>; rel="next"' }))
	const client = createClient({ token: "t", fetch: f.fn })
	const page = await client.page<number>("/x")
	expect(page.items).toEqual([1])
	expect(page.next).toBe("https://api.github.com/x?page=2")
})

test("maps 401 to an auth error", async () => {
	const client = createClient({ token: "t", fetch: fakeFetch(() => json({ message: "Bad credentials" }, {}, 401)).fn })
	await expect(client.json("/user")).rejects.toMatchObject({ kind: "auth", status: 401 })
})

test("maps an exhausted rate limit to a rateLimit error with its reset time", async () => {
	const f = fakeFetch(() => json({ message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" }, 403))
	const client = createClient({ token: "t", fetch: f.fn })
	const err = (await client.json("/user").catch(e => e)) as GitHubError
	expect(err).toBeInstanceOf(GitHubError)
	expect(err.kind).toBe("rateLimit")
	expect(err.resetAt).toBe(1700000000_000)
})

test("waits retry-after once on a secondary limit, then succeeds", async () => {
	let n = 0
	const f = fakeFetch(() => (++n === 1 ? json({ message: "secondary" }, { "retry-after": "0" }, 403) : json({ ok: true })))
	const client = createClient({ token: "t", fetch: f.fn })
	expect(await client.json("/x")).toEqual({ ok: true })
	expect(n).toBe(2)
})

test("maps 404 to notFound", async () => {
	const client = createClient({ token: "t", fetch: fakeFetch(() => json({ message: "Not Found" }, {}, 404)).fn })
	await expect(client.json("/repos/a/b")).rejects.toMatchObject({ kind: "notFound" })
})

test("maps a failed fetch to a network error", async () => {
	const client = createClient({
		token: "t",
		fetch: (async () => {
			throw new TypeError("Failed to fetch")
		}) as typeof fetch,
	})
	await expect(client.json("/x")).rejects.toMatchObject({ kind: "network" })
})

test("raw() asks for raw bytes", async () => {
	const f = fakeFetch(() => new Response(new Uint8Array([1, 2, 3])))
	const client = createClient({ token: "t", fetch: f.fn })
	expect(await client.raw("/repos/a/b/git/blobs/abc")).toEqual(new Uint8Array([1, 2, 3]))
	expect(f.calls[0]!.headers.Accept).toBe("application/vnd.github.raw+json")
})

test("runs at most 6 requests at once", async () => {
	let live = 0
	let peak = 0
	const f = fakeFetch(async () => {
		peak = Math.max(peak, ++live)
		await new Promise(r => setTimeout(r, 5))
		live--
		return json({})
	})
	const client = createClient({ token: "t", fetch: f.fn })
	await Promise.all(Array.from({ length: 20 }, (_, i) => client.json(`/x/${i}`)))
	expect(peak).toBe(6)
})

test("a foreground request overtakes queued background ones", async () => {
	const order: string[] = []
	const release: (() => void)[] = []
	const f = fakeFetch(async url => {
		order.push(url.replace("https://api.github.com", ""))
		await new Promise<void>(r => release.push(r))
		return json({})
	})
	const client = createClient({ token: "t", fetch: f.fn, maxConcurrent: 3 })
	const bg = Array.from({ length: 5 }, (_, i) => client.json(`/bg/${i}`, { background: true }))
	await new Promise(r => setTimeout(r, 0))
	// Background may only take max - 2 = 1 slot, so a foreground request starts at once.
	expect(order).toEqual(["/bg/0"])
	const fg = client.json("/fg")
	await new Promise(r => setTimeout(r, 0))
	expect(order).toEqual(["/bg/0", "/fg"])
	while (release.length || order.length < 6) {
		release.shift()?.()
		await new Promise(r => setTimeout(r, 0))
	}
	await Promise.all([...bg, fg])
	expect(order).toHaveLength(6)
})

test("identical requests in flight share one fetch", async () => {
	let n = 0
	const f = fakeFetch(async () => {
		n++
		await new Promise(r => setTimeout(r, 5))
		return json({ v: 1 })
	})
	const client = createClient({ token: "t", fetch: f.fn })
	const [a, b] = await Promise.all([client.json("/same"), client.json("/same")])
	expect(a).toEqual({ v: 1 })
	expect(b).toEqual({ v: 1 })
	expect(n).toBe(1)
})
