import { useEffect, useState } from "react"
import { discoverProjects, type Discovery } from "../github/discovery"
import type { GitHub } from "../github/github"
import { handleAuthError } from "../github/session"

export interface GitHubProjects {
	discovery: Discovery | null
	loading: boolean
	error: string | null
	refresh(): void
}

// Kept across visits to the home screen, so the tree doesn't flash empty while it revalidates.
let remembered: { key: string; discovery: Discovery } | null = null

// The projects the session can see: the signed-in user's own repos, or the owner's public ones.
export function useGitHubProjects(gh: GitHub, owner: string): GitHubProjects {
	const key = `${gh.anonymous ? "public" : "own"}:${owner}`
	const [discovery, setDiscovery] = useState<Discovery | null>(remembered && remembered.key === key ? remembered.discovery : null)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [generation, setGeneration] = useState(0)

	useEffect(() => {
		let live = true
		setLoading(true)
		setError(null)
		if (remembered?.key !== key) setDiscovery(null)
		discoverProjects(gh, owner, d => live && setDiscovery(d))
			.then(d => {
				if (!live) return
				setDiscovery(d)
				remembered = { key, discovery: d }
			})
			.catch(e => live && !handleAuthError(e) && setError(e instanceof Error ? e.message : String(e)))
			.finally(() => live && setLoading(false))
		return () => {
			live = false
		}
	}, [gh, owner, key, generation])

	return { discovery, loading, error, refresh: () => setGeneration(g => g + 1) }
}
