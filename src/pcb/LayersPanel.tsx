import { Eye, EyeOff, FlipHorizontal2, RotateCcw, X } from "lucide-react"
import { LAYER_MODES, MODE_NAMES, type LayerState } from "./layer-state"
import type { PcbScene } from "./scene"

const OBJECT_KINDS: { kind: string; label: string }[] = [
	{ kind: "arc", label: "Arcs" },
	{ kind: "pad", label: "Pads" },
	{ kind: "via", label: "Vias" },
	{ kind: "track", label: "Tracks" },
	{ kind: "text", label: "Texts" },
	{ kind: "fill", label: "Fills" },
	{ kind: "region", label: "Regions" },
	{ kind: "body", label: "3D Body" },
]

// The Layers/Objects panel: mirror the board (bottom view), the layer mode, and which object types
// show. The layers themselves are in the legend on the board.
export function LayersPanel({ scene, state, onChange, onReset, onClose }: {
	scene: PcbScene
	state: LayerState
	onChange(next: LayerState): void
	onReset(): void
	onClose(): void
}) {
	return (
		<aside className="pcb-layers" aria-label="Layers and objects">
			<div className="pcb-layers-tabs">
				<span className="pcb-layers-title">Layers/Objects</span>
				<span className="grow" />
				<button className="icon" aria-label="Reset" onClick={onReset}>
					<RotateCcw size={14} />
				</button>
				<button className="icon" aria-label="Close" onClick={onClose}>
					<X size={14} />
				</button>
			</div>
			<div className="pcb-layers-section">
				<button className={`pcb-flip${state.flip ? " on" : ""}`} aria-pressed={state.flip} onClick={() => onChange({ ...state, flip: !state.flip })}>
					<FlipHorizontal2 size={16} />
					<span className="grow">Flip</span>
					<kbd>F</kbd>
				</button>
			</div>
			<div className="pcb-layers-section">
				<div className="pcb-layers-label">
					<span className="grow">Layer mode</span>
					<span>
						<kbd>Shift</kbd>+<kbd>S</kbd>
					</span>
				</div>
				<div className="pcb-modes" role="radiogroup" aria-label="Layer mode">
					{LAYER_MODES.map(m => (
						<button key={m} role="radio" aria-checked={state.mode === m} onClick={() => onChange({ ...state, mode: m })}>
							{MODE_NAMES[m]}
						</button>
					))}
				</div>
			</div>
			<div className="pcb-layers-list">
				<div className="pcb-layers-group static">All Objects</div>
				{OBJECT_KINDS.filter(k => scene.objects.some(o => o.kind === k.kind)).map(k => {
					const on = !state.hiddenKinds.has(k.kind)
					return (
						<div key={k.kind} className={`pcb-layer-row${on ? "" : " hidden"}`} data-kind={k.kind}>
							<span className="grow">{k.label}</span>
							<button
								className="icon eye"
								aria-label={`${on ? "Hide" : "Show"} ${k.label}`}
								onClick={() => {
									const hiddenKinds = new Set(state.hiddenKinds)
									if (on) hiddenKinds.add(k.kind)
									else hiddenKinds.delete(k.kind)
									onChange({ ...state, hiddenKinds })
								}}
							>
								{on ? <Eye size={14} /> : <EyeOff size={14} />}
							</button>
						</div>
					)
				})}
			</div>
		</aside>
	)
}
