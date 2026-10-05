// A small GitHub REST client for the browser: token auth, ETag revalidation (a 304 doesn't count
// against the rate limit), Link-header paging, a cap on concurrent requests and typed errors.

export type GitHubErrorKind = "auth" | "notFound" | "forbidden" | "rateLimit" | "network" | "other"

export class GitHubError extends Error {
	constructor(
		readonly kind: GitHubErrorKind,
		message: string,
		readonly status = 0,
		readonly resetAt: number | null = null,
	) {
		super(message)
		this.name = "GitHubError"
	}
}

export interface EtagEntry {
	etag: string
	body: unknown
}

// Where revalidation state lives; the app persists it in IndexedDB so a reload still gets 304s.
export interface EtagStore {
	get(url: string): Promise<EtagEntry | undefined>
	set(url: string, entry: EtagEntry): Promise<void>
}

export function memoryEtagStore(): EtagStore {
	const map = new Map<string, EtagEntry>()
	return { get: async url => map.get(url), set: async (url, e) => void map.set(url, e) }
}

export interface Page<T> {
	items: T[]
	next: string | null
}

// Background requests (e.g. the home screen's "last changed" lookups) never take the last slots, and
// a freed slot goes to waiting foreground requests first, so opening a commit isn't stuck behind them.
export interface RequestOptions {
	background?: boolean
}

export interface GitHubClient {
	json<T>(path: string, o?: RequestOptions): Promise<T>
	page<T>(pathOrUrl: string, o?: RequestOptions): Promise<Page<T>>
	pages<T>(path: string, maxPages?: number, o?: RequestOptions): Promise<T[]>
	raw(path: string, o?: RequestOptions): Promise<Uint8Array>
}

export interface ClientOptions {
	token: string // "" for anonymous access (public repos, GitHub's lower visitor limit)
	fetch?: typeof fetch
	etags?: EtagStore
	base?: string
	maxConcurrent?: number
	// Reuse a JSON answer from memory for this long instead of asking again (anonymous visits: each
	// request counts against GitHub's 60-an-hour limit, conditional ones included).
	memoMs?: number
}

const API_VERSION = "2022-11-28"
const MAX_RETRY_AFTER_S = 60

export function createClient(opts: ClientOptions): GitHubClient {
	const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
	const base = opts.base ?? "https://api.github.com"
	const etags = opts.etags
	const limit = limiter(opts.maxConcurrent ?? 6)
	const inflight = new Map<string, Promise<{ body: unknown; link: string | null }>>()
	const memo = new Map<string, { at: number; value: { body: unknown; link: string | null } }>()
	const urlOf = (p: string) => (p.startsWith("http") ? p : base + p)

	async function request(url: string, accept: string, background: boolean, etag?: string): Promise<Response> {
		const headers: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": API_VERSION }
		if (opts.token) headers.Authorization = `Bearer ${opts.token}`
		if (etag) headers["If-None-Match"] = etag
		for (let attempt = 0; ; attempt++) {
			let res: Response
			try {
				res = await limit(() => doFetch(url, { headers, cache: "no-store" }), background)
			} catch {
				const offline = typeof navigator !== "undefined" && navigator.onLine === false
				throw new GitHubError("network", offline ? "You're offline" : "Couldn't reach GitHub")
			}
			if (res.ok || res.status === 304) return res
			const retryAfter = Number(res.headers.get("retry-after"))
			if (attempt === 0 && (res.status === 403 || res.status === 429) && res.headers.has("retry-after") && retryAfter <= MAX_RETRY_AFTER_S) {
				await new Promise(r => setTimeout(r, retryAfter * 1000))
				continue
			}
			throw await toError(res)
		}
	}

	async function fetchJson(url: string, background: boolean): Promise<{ body: unknown; link: string | null }> {
		const cached = etags ? await etags.get(url) : undefined
		const res = await request(url, "application/vnd.github+json", background, cached?.etag)
		const link = res.headers.get("link")
		if (res.status === 304 && cached) return { body: cached.body, link }
		const body = await res.json()
		const etag = res.headers.get("etag")
		if (etags && etag) await etags.set(url, { etag, body })
		return { body, link }
	}

	// Identical requests already in flight share one response.
	function getJson<T>(url: string, background = false): Promise<{ body: T; link: string | null }> {
		const kept = opts.memoMs ? memo.get(url) : undefined
		if (kept && Date.now() - kept.at < opts.memoMs!) return Promise.resolve(kept.value as { body: T; link: string | null })
		let p = inflight.get(url)
		if (!p) {
			p = fetchJson(url, background)
				.then(value => {
					if (opts.memoMs) memo.set(url, { at: Date.now(), value })
					return value
				})
				.finally(() => inflight.delete(url))
			inflight.set(url, p)
		}
		return p as Promise<{ body: T; link: string | null }>
	}

	const client: GitHubClient = {
		json: async <T>(path: string, o?: RequestOptions) => (await getJson<T>(urlOf(path), o?.background)).body,
		async page<T>(pathOrUrl: string, o?: RequestOptions) {
			const { body, link } = await getJson<T[]>(urlOf(pathOrUrl), o?.background)
			return { items: body, next: nextLink(link) }
		},
		async pages<T>(path: string, maxPages = 50, o?: RequestOptions) {
			const out: T[] = []
			let next: string | null = urlOf(path)
			for (let i = 0; next && i < maxPages; i++) {
				const p: Page<T> = await client.page<T>(next, o)
				out.push(...p.items)
				next = p.next
			}
			return out
		},
		async raw(path: string, o?: RequestOptions) {
			const res = await request(urlOf(path), "application/vnd.github.raw+json", o?.background ?? false)
			return new Uint8Array(await res.arrayBuffer())
		},
	}
	return client
}

export function nextLink(link: string | null): string | null {
	if (!link) return null
	for (const part of link.split(",")) {
		const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part)
		if (m) return m[1]!
	}
	return null
}

async function toError(res: Response): Promise<GitHubError> {
	let message = res.statusText
	try {
		message = ((await res.json()) as { message?: string }).message ?? message
	} catch {
		// not JSON
	}
	if (res.status === 401) return new GitHubError("auth", "Your GitHub token stopped working", 401)
	if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
		const reset = Number(res.headers.get("x-ratelimit-reset"))
		const resetAt = reset ? reset * 1000 : null
		const at = resetAt ? ` — resets at ${new Date(resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""
		return new GitHubError("rateLimit", `GitHub rate limit reached${at}`, res.status, resetAt)
	}
	if (res.status === 404) return new GitHubError("notFound", message || "Not found", 404)
	if (res.status === 403) return new GitHubError("forbidden", message || "Forbidden", 403)
	return new GitHubError("other", `GitHub: ${message || res.status}`, res.status)
}

function limiter(max: number) {
	const maxBackground = Math.max(1, max - 2)
	let live = 0
	let liveBackground = 0
	const fore: (() => void)[] = []
	const back: (() => void)[] = []
	const wake = () => {
		if (live >= max) return
		const next = fore.shift() ?? (liveBackground < maxBackground ? back.shift() : undefined)
		next?.()
	}
	return async <T>(fn: () => Promise<T>, background = false): Promise<T> => {
		const free = () => live < max && (!background || liveBackground < maxBackground)
		if (!free() || fore.length > 0 || (background && back.length > 0)) await new Promise<void>(r => (background ? back : fore).push(r))
		live++
		if (background) liveBackground++
		try {
			return await fn()
		} finally {
			live--
			if (background) liveBackground--
			wake()
		}
	}
}
