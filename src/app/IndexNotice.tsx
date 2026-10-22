import { useEffect, useState } from "react"
import { X } from "lucide-react"
import { OWNER, REPOS } from "../github/config"
import type { IndexFreshness } from "../github/github"
import { useSession } from "../github/session"

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "?")
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "none")

// The commit index the site reads GitHub projects through, checked against GitHub when the app opens
// (and again on signing in): a notice when it is behind, or when it could not be checked.
export function IndexNotice() {
	const gh = useSession(s => s.session.gh)
	const [notes, setNotes] = useState<IndexFreshness[]>([])
	const [closed, setClosed] = useState(false)
	useEffect(() => {
		let live = true
		void Promise.all(REPOS.map(repo => gh.indexFreshness({ owner: OWNER, repo }).catch(() => null))).then(all => {
			if (!live) return
			setNotes(all.filter((n): n is IndexFreshness => n !== null && n.status !== "current"))
			setClosed(false)
		})
		return () => {
			live = false
		}
	}, [gh])
	if (closed || notes.length === 0) return null
	const stale = notes.some(n => n.status === "behind")
	return (
		<div className={`index-notice${stale ? " stale" : ""}`} role={stale ? "alert" : "status"} aria-label="Commit index">
			<div className="index-notice-text">
				{notes.map(n => (
					<p key={n.repo}>
						{n.status === "behind" ? (
							<>
								<strong>Stale data:</strong> the commit index for {n.repo} stops at {short(n.branches[0]!.indexed)} ({day(n.indexedDate)}), GitHub&apos;s{" "}
								{n.branches[0]!.name} is at {short(n.branches[0]!.live)} ({day(n.liveDate)}){n.branches.length > 1 ? ` (and ${n.branches.length - 1} more branch${n.branches.length > 2 ? "es" : ""})` : ""}. Newer
								commits are not listed. Rebuild it with <code>npm run index</code> after pulling, then reload.
							</>
						) : n.status === "unchecked" ? (
							<>
								The commit index for {n.repo} (up to {day(n.indexedDate)}, built {day(n.generatedAt)}) could not be checked against GitHub: {n.reason}.
							</>
						) : null}
					</p>
				))}
			</div>
			<button className="icon" aria-label="Dismiss" onClick={() => setClosed(true)}>
				<X size={14} />
			</button>
		</div>
	)
}
