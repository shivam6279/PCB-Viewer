import { useState } from "react"
import { useAppStore, type DeltaMode } from "../app/store"
import type { Deltas } from "../app/use-deltas"
import { PickMenu } from "../pcb/PickMenu"

// Comparing, on the doc bar: how the differences show (none, over the view, over it greyed), what
// was found, and (PCB) the list of changed places: picking one goes there.
export function DeltaBar({ deltas, here, there, focus, onFocus }: {
	deltas: Deltas
	here: string // the commit shown: "A" or "B"
	there: string
	focus: number | null
	onFocus(area: number): void
}) {
	const mode = useAppStore(s => s.deltas)
	const [listAt, setListAt] = useState<{ x: number; y: number } | null>(null)
	const areas = deltas?.areas
	return (
		<>
			{deltas?.mark && mode !== "none" && (
				<span className="diff-legend">
					<span className="added">only in {here}</span>
					<span className="removed">only in {there}</span>
				</span>
			)}
			{areas?.length ? (
				<button
					className="delta-changes"
					aria-haspopup="menu"
					onClick={e => {
						const r = e.currentTarget.getBoundingClientRect()
						setListAt(listAt ? null : { x: r.right - 720, y: r.bottom + 4 })
					}}
				>
					{`${deltas!.note} ▾`}
				</button>
			) : (
				<span className="delta-note">{deltas === null ? "Comparing…" : deltas.note}</span>
			)}
			<div className="mode-bar" role="group" aria-label="Differences">
				{(["none", "deltas", "only"] as DeltaMode[]).map(m => (
					<button key={m} aria-pressed={mode === m} onClick={() => useAppStore.getState().setDeltas(m)}>
						{m === "none" ? "No deltas" : m === "deltas" ? "Deltas" : "Deltas only"}
					</button>
				))}
			</div>
			{listAt && areas && (
				<PickMenu
					x={listAt.x}
					y={listAt.y}
					label="Changes"
					rows={areas.map((r, i) => ({ key: String(i), kind: r.kind, label: r.label, detail: r.detail, current: focus === i }))}
					onPick={key => onFocus(Number(key))}
					onHover={() => {}}
					onClose={() => setListAt(null)}
				/>
			)}
		</>
	)
}
