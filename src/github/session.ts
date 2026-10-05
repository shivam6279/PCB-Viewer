import { create } from "zustand"
import { createClient, GitHubError } from "./client"
import { defaultOwner } from "./config"
import { GitHub } from "./github"
import { idbObjectCache, memoryObjectCache, type ObjectCache } from "./object-cache"
import { StaticIndex } from "./static-index"

// There is always a GitHub to read from. Without a token it is anonymous: the default owner's public
// repos, under GitHub's per-visitor limit. Signing in (a pasted read-only token, kept in localStorage)
// adds the user's private repos and a much higher limit.
const TOKEN_KEY = "github-token"
const ANON_MEMO_MS = 10 * 60_000 // anonymous: a branch, history or repo list is asked at most every 10 min

export type SessionState =
	| { status: "anonymous"; gh: GitHub; owner: string; error: string | null }
	| { status: "checking"; gh: GitHub; owner: string } // the anonymous one keeps working meanwhile
	| { status: "signedIn"; gh: GitHub; owner: string; login: string }

interface SessionStore {
	session: SessionState
	signIn(token: string): Promise<boolean>
	signOut(error?: string | null): void
	restore(): Promise<void>
}

let cache: ObjectCache | null = null
const objectCache = () => (cache ??= typeof indexedDB === "undefined" ? memoryObjectCache() : idbObjectCache())

// Swappable for tests.
export const sessionDeps = {
	fetch: undefined as typeof fetch | undefined,
	objectCache,
}

export function makeGitHub(token: string): GitHub {
	const c = sessionDeps.objectCache()
	const fetchFn = sessionDeps.fetch
	const anonymous = token === ""
	const client = createClient({ token, fetch: fetchFn, etags: c.etags, memoMs: anonymous ? ANON_MEMO_MS : undefined })
	return new GitHub(client, c, anonymous, fetchFn ?? ((...a) => globalThis.fetch(...a)), siteIndex())
}

// The index the deploy publishes beside the page (index/), shared by every session.
let index: StaticIndex | null | undefined
function siteIndex(): StaticIndex | null {
	if (index === undefined) index = typeof document === "undefined" ? null : new StaticIndex(new URL("index/", document.baseURI).href, sessionDeps.fetch)
	return index
}

let anonymousGitHub: GitHub | null = null
const anonymous = (error: string | null = null): SessionState => ({ status: "anonymous", gh: (anonymousGitHub ??= makeGitHub("")), owner: defaultOwner(), error })

const storage = {
	get: () => {
		try {
			return localStorage.getItem(TOKEN_KEY)
		} catch {
			return null
		}
	},
	set: (t: string) => {
		try {
			localStorage.setItem(TOKEN_KEY, t)
		} catch {
			// storage blocked: the session still works until the tab closes
		}
	},
	clear: () => {
		try {
			localStorage.removeItem(TOKEN_KEY)
		} catch {
			// nothing stored
		}
	},
}

export const useSession = create<SessionStore>((set, get) => ({
	session: anonymous(),
	async signIn(token) {
		token = token.trim()
		if (!token) return false
		const before = get().session
		set({ session: { status: "checking", gh: before.gh, owner: before.owner } })
		const gh = makeGitHub(token)
		try {
			const { login } = await gh.user()
			storage.set(token)
			set({ session: { status: "signedIn", gh, owner: login, login } })
			return true
		} catch (e) {
			const error =
				e instanceof GitHubError && e.kind === "auth" ? "GitHub didn't accept that token — check it was copied whole and hasn't expired" : e instanceof Error ? e.message : String(e)
			set({ session: anonymous(error) })
			return false
		}
	},
	signOut(error = null) {
		storage.clear()
		set({ session: anonymous(error) })
	},
	async restore() {
		const token = storage.get()
		if (!token || get().session.status !== "anonymous") return
		const ok = await get().signIn(token)
		if (!ok) {
			const s = get().session
			// Offline at startup: keep the token for next time; only a refused one is dropped.
			if (s.status === "anonymous" && s.error && !/token/i.test(s.error)) storage.set(token)
			else storage.clear()
		}
	},
}))

// An expired or revoked token shows up as a 401 on any call: drop it and carry on anonymously.
export function handleAuthError(e: unknown): boolean {
	if (e instanceof GitHubError && e.kind === "auth" && useSession.getState().session.status === "signedIn") {
		useSession.getState().signOut("Your GitHub token stopped working — showing public projects only. Sign in again for private ones.")
		return true
	}
	return false
}

export function currentGitHub(): GitHub {
	return useSession.getState().session.gh
}
