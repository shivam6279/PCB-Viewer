import { useState } from "react"
import { ChevronDown, ChevronRight, Eye, EyeOff, RotateCcw, X } from "lucide-react"
import { GROUP_NAMES, GROUP_ORDER, type LayerGroup } from "./layers"
import type { LayerState } from "./PcbView"
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

// The Layers/Objects panel: which layers show, which one is current (drawn on top of the
// other copper), single-layer "Only" mode, the board side, and object types.
export function LayersPanel({ scene, state, onChange, onReset, onClose }: {
	scene: PcbScene
	state: LayerState
	onChange(next: LayerState): void
	onReset(): void
	onClose(): void
}) {
	const [tab, setTab] = useState<"layers" | "objects">("layers")
	const [collapsed, setCollapsed] = useState<Set<LayerGroup>>(new Set())
	const shown = (key: string) => (state.only ? state.only === key : state.visible.has(key))
	const toggleVisible = (key: string) => {
		const visible = new Set(state.visible)
		if (state.only) {
			// Leaving single-layer mode: everything that was visible before, plus this layer's choice.
			onChange({ ...state, only: null })
			return
		}
		if (visible.has(key)) visible.delete(key)
		else visible.add(key)
		onChange({ ...state, visible })
	}
	const side = (
		<div className="pcb-layers-side">
			<button className={state.flip ? "" : "on"} onClick={() => onChange({ ...state, flip: false })}>
				Top
			</button>
			<button className={state.flip ? "on" : ""} onClick={() => onChange({ ...state, flip: true })}>
				Bottom
			</button>
		</div>
	)

	return (
		<aside className="pcb-layers" aria-label="Layers and objects">
			<div className="pcb-layers-tabs">
				<button className={tab === "layers" ? "on" : ""} onClick={() => setTab("layers")}>
					Layers
				</button>
				<button className={tab === "objects" ? "on" : ""} onClick={() => setTab("objects")}>
					Objects
				</button>
				<span className="grow" />
				<button className="icon" aria-label="Reset" onClick={onReset}>
					<RotateCcw size={14} />
				</button>
				<button className="icon" aria-label="Close" onClick={onClose}>
					<X size={14} />
				</button>
			</div>
			{side}
			<div className="pcb-layers-list">
				{tab === "layers" &&
					GROUP_ORDER.map(group => {
						const layers = scene.layers.filter(l => l.group === group)
						if (layers.length === 0) return null
						const open = !collapsed.has(group)
						return (
							<div key={group}>
								<button
									className="pcb-layers-group"
									onClick={() =>
										setCollapsed(prev => {
											const next = new Set(prev)
											if (next.has(group)) next.delete(group)
											else next.add(group)
											return next
										})
									}
								>
									{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
									{GROUP_NAMES[group]}
								</button>
								{open &&
									layers.map(l => (
										<div key={l.key} className={`pcb-layer-row${shown(l.key) ? "" : " hidden"}`} data-layer={l.key}>
											<input
												type="checkbox"
												aria-label={`Current layer ${l.name}`}
												checked={state.current === l.key}
												disabled={l.group !== "copper"}
												onChange={() => onChange({ ...state, current: l.key, only: state.only ? l.key : null })}
											/>
											<span className="swatch" style={{ background: l.color }} />
											<span className="grow">{l.name}</span>
											<button className="only" onClick={() => onChange({ ...state, only: state.only === l.key ? null : l.key, current: l.group === "copper" ? l.key : state.current })}>
												Only
											</button>
											<button className="icon eye" aria-label={`${shown(l.key) ? "Hide" : "Show"} ${l.name}`} onClick={() => toggleVisible(l.key)}>
												{shown(l.key) ? <Eye size={14} /> : <EyeOff size={14} />}
											</button>
										</div>
									))}
							</div>
						)
					})}
				{tab === "objects" && (
					<div>
						<div className="pcb-layers-group static">All Objects</div>
						{OBJECT_KINDS.filter(k => scene.objects.some(o => o.kind === k.kind)).map(k => {
							const on = !state.hiddenKinds.has(k.kind)
							return (
								<div key={k.kind} className={`pcb-layer-row${on ? "" : " hidden"}`}>
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
				)}
			</div>
			<div className="pcb-layers-foot">
				<span>Next / Previous Layer</span>
				<span>Key +/-</span>
			</div>
		</aside>
	)
}
