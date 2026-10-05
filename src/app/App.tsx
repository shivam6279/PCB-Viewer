import { useEffect } from "react"
import { useSession } from "../github/session"
import { applyRoute, currentRoute } from "./github-open"
import { Spinner } from "./Spinner"
import { openingLabel, useOpening } from "./opening"
import { useAppStore } from "./store"
import { Home } from "./Home"
import { ProjectPicker } from "./ProjectPicker"
import { Viewer } from "./Viewer"

export default function App() {
	const kind = useAppStore(s => s.screen.kind)
	const signedIn = useSession(s => s.session.status === "signedIn")
	const hasParked = useAppStore(s => s.parked !== null)

	useEffect(() => {
		// A saved token is tried first, so a link to a private project doesn't fail anonymously on the way.
		void useSession
			.getState()
			.restore()
			.then(() => applyRoute(currentRoute()))
		const onHash = () => void applyRoute(currentRoute())
		window.addEventListener("hashchange", onHash)
		return () => window.removeEventListener("hashchange", onHash)
	}, [])

	// Signing in re-applies the URL (a private project that couldn't open anonymously now can).
	useEffect(() => {
		if (signedIn) void applyRoute(currentRoute())
	}, [signedIn])

	// The viewer stays at one place in the tree, so parking it behind the home screen and coming back
	// keeps everything it built (views, camera, selection) instead of remounting.
	const front = kind === "viewer" ? null : kind === "pick" ? <ProjectPicker /> : kind === "loading" && currentRoute().kind === "ghCommit" ? <LoadingScreen /> : <Home />
	return (
		<>
			<div className={`viewer-host${front ? " parked" : ""}`} aria-hidden={front ? true : undefined}>
				{(kind === "viewer" || hasParked) && <Viewer />}
			</div>
			{front}
		</>
	)
}

// A GitHub link opened fresh: nothing to keep on screen while the commit downloads.
function LoadingScreen() {
	const screen = useAppStore(s => s.screen)
	const opening = useOpening(s => s.opening)
	return (
		<div className="start">
			<div className="gh-loading" role="status">
				<Spinner size={28} />
				<div>{screen.kind === "loading" ? screen.label : ""}</div>
				<div className="dim">{opening ? openingLabel(opening) : ""}</div>
			</div>
		</div>
	)
}
