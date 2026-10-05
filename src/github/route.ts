// Hash URLs for the GitHub screens, so they survive a reload and work on any static host.
//   #/                                           home
//   #/gh/<owner>/<repo>/project/<prjPath>?branch=<b>   project page
//   #/gh/<owner>/<repo>/<sha>/<prjPath>[?vs=<sha>]  viewer at a commit [compared with another]
export type Route =
	| { kind: "home" }
	| { kind: "ghProject"; owner: string; repo: string; prjPath: string; branch: string | null }
	| { kind: "ghCommit"; owner: string; repo: string; sha: string; prjPath: string; vs?: string | null }

const SHA = /^[0-9a-f]{40}$/i

export function parseRoute(hash: string): Route {
	const h = hash.replace(/^#/, "")
	const [pathPart, query = ""] = h.split("?", 2) as [string, string?]
	const parts = pathPart.split("/").filter(Boolean).map(safeDecode)
	if (parts[0] !== "gh" || parts.length < 5) return { kind: "home" }
	const [, owner, repo, third, ...rest] = parts as [string, string, string, string, ...string[]]
	const prjPath = rest.join("/")
	if (third === "project") return { kind: "ghProject", owner, repo, prjPath, branch: new URLSearchParams(query).get("branch") }
	if (SHA.test(third)) {
		const vs = new URLSearchParams(query).get("vs")
		return { kind: "ghCommit", owner, repo, sha: third.toLowerCase(), prjPath, ...(vs && SHA.test(vs) ? { vs: vs.toLowerCase() } : {}) }
	}
	return { kind: "home" }
}

export function formatRoute(r: Route): string {
	const seg = (p: string) => p.split("/").map(encodeURIComponent).join("/")
	switch (r.kind) {
		case "home":
			return "#/"
		case "ghProject":
			return `#/gh/${seg(r.owner)}/${seg(r.repo)}/project/${seg(r.prjPath)}${r.branch ? `?branch=${encodeURIComponent(r.branch)}` : ""}`
		case "ghCommit":
			return `#/gh/${seg(r.owner)}/${seg(r.repo)}/${r.sha}/${seg(r.prjPath)}${r.vs ? `?vs=${r.vs}` : ""}`
	}
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}
