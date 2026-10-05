import { ChevronDown, ChevronRight, Eye, EyeOff, RotateCcw, X } from "lucide-react"
import { useState, type ReactNode } from "react"

// Small object-type icons, drawn here.
const BLUE = "#6aa7e6", GOLD = "#e8c440", ORANGE = "#e09a3a"
const ICONS: Record<string, ReactNode> = {
	arc: <path d="M3 12a5 5 0 0 1 10 0" fill="none" stroke={BLUE} strokeWidth="1.5" />,
	pad: <><circle cx="8" cy="8" r="5" fill={GOLD} /><circle cx="8" cy="8" r="1.8" fill="#5a4a10" /></>,
	via: <><circle cx="6" cy="7" r="4" fill={GOLD} /><circle cx="6" cy="7" r="1.5" fill="#5a4a10" /><path d="M9 9h5" stroke="#5cc15c" strokeWidth="2" /></>,
	track: <><path d="M3 13L13 3" stroke={ORANGE} strokeWidth="1.5" /><circle cx="3" cy="13" r="1.8" fill={GOLD} /><circle cx="13" cy="3" r="1.8" fill={GOLD} /></>,
	text: <text x="8" y="13" textAnchor="middle" fontSize="13" fontWeight="bold" fontFamily="serif" fill={BLUE}>A</text>,
	fill: <rect x="2" y="4" width="12" height="9" fill="#bcd8f2" stroke={BLUE} />,
	polygon: <path d="M8 2l6 4.5-2.3 7H4.3L2 6.5z" fill={BLUE} />,
	region: <path d="M8 2l6 4.5-2.3 7H4.3L2 6.5z" fill="none" stroke={BLUE} strokeWidth="1.3" />,
	body: <><path d="M2 9l6-3 6 3-6 3z" fill={BLUE} /><path d="M2 9v2l6 3 6-3V9l-6 3z" fill="#3d6fa3" /></>,
	dimension: <><text x="5" y="7" fontSize="7" fill={ORANGE}>10</text><path d="M3 13L13 9" stroke={ORANGE} strokeWidth="1.3" /></>,
}

// The 3D view's Objects panel: Top / Bottom, and which object types show.
export const OBJECT_KINDS_3D: { kind: string; label: string }[] = [
	{ kind: "arc", label: "Arcs" },
	{ kind: "pad", label: "Pads" },
	{ kind: "via", label: "Vias" },
	{ kind: "track", label: "Tracks" },
	{ kind: "text", label: "Texts" },
	{ kind: "fill", label: "Fills" },
	{ kind: "polygon", label: "Polygons" },
	{ kind: "region", label: "Regions" },
	{ kind: "body", label: "3D Body" },
	{ kind: "dimension", label: "Dimensions" },
]

export interface Objects3dState {
	side: "top" | "bottom" | null // the side button last pressed (none at first)
	hiddenKinds: Set<string>
}

export function ObjectsPanel({ state, onSide, onKinds, onReset, onClose }: {
	state: Objects3dState
	onSide(side: "top" | "bottom"): void
	onKinds(hidden: Set<string>): void
	onReset(): void
	onClose(): void
}) {
	const [open, setOpen] = useState(true)
	const changed = state.hiddenKinds.size > 0
	return (
		<aside className="pcb-layers objects-3d" aria-label="Objects">
			<div className="pcb-layers-tabs">
				<span className="objects-3d-title">Objects</span>
				<span className="grow" />
				{changed && (
					<button className="icon" aria-label="Reset" onClick={onReset}>
						<RotateCcw size={14} />
					</button>
				)}
				<button className="icon" aria-label="Close" onClick={onClose}>
					<X size={14} />
				</button>
			</div>
			<div className="pcb-layers-side objects-3d-side">
				<button className={state.side === "top" ? "on" : ""} onClick={() => onSide("top")}>
					Top
				</button>
				<button className={state.side === "bottom" ? "on" : ""} onClick={() => onSide("bottom")}>
					Bottom
				</button>
			</div>
			<div className="pcb-layers-list">
				<button className="pcb-layers-group" onClick={() => setOpen(!open)}>
					{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					All Objects
				</button>
				{open &&
					OBJECT_KINDS_3D.map(k => {
						const on = !state.hiddenKinds.has(k.kind)
						return (
							<div key={k.kind} className={`pcb-layer-row${on ? "" : " hidden"}`} data-kind={k.kind}>
								<svg className="kind-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
									{ICONS[k.kind]}
								</svg>
								<span className="grow">{k.label}</span>
								<button className="only" onClick={() => onKinds(new Set(OBJECT_KINDS_3D.map(o => o.kind).filter(o => o !== k.kind)))}>
									Only
								</button>
								<button
									className="icon eye"
									aria-label={`${on ? "Hide" : "Show"} ${k.label}`}
									onClick={() => {
										const next = new Set(state.hiddenKinds)
										if (on) next.add(k.kind)
										else next.delete(k.kind)
										onKinds(next)
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
