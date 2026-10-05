import { openProject } from "./open"
import { useAppStore } from "./store"

export function ProjectPicker() {
	const screen = useAppStore(s => s.screen)
	if (screen.kind !== "pick") return null
	return (
		<div className="start">
			<div className="start-card">
				<h2>Choose a project in {screen.source.name}</h2>
				<div className="list">
					{screen.projects.map(p => (
						<button key={p} onClick={() => openProject(screen.source, screen.handle, p)}>
							{p}
						</button>
					))}
				</div>
				<button className="btn" onClick={() => useAppStore.getState().setScreen({ kind: "start", error: null })}>
					Back
				</button>
			</div>
		</div>
	)
}
