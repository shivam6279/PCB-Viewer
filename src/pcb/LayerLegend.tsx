import { ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, FlipHorizontal2 } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react"
import { GROUP_NAMES, GROUP_ORDER } from "./layers"
import { makeCurrent, MODE_NAMES, nextMode, toggleVisible, type LayerState } from "./layer-state"
import type { PcbScene } from "./scene"

interface LegendBox {
	x: number // from the board area's top left (past the Layers/Objects panel when that is open)
	y: number
	w: number
	h: number | null // null: as tall as its layers (up to the board area)
}
const BOX_KEY = "pcb.legend.box"
const PANEL_WIDTH = 248
const MIN_W = 180
const MIN_H = 120
const DEFAULT_BOX: LegendBox = { x: 12, y: 12, w: 232, h: null }
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))

function storedBox(): LegendBox {
	try {
		const b = JSON.parse(localStorage.getItem(BOX_KEY) ?? "null") as LegendBox | null
		if (b && [b.x, b.y, b.w].every(Number.isFinite)) return { x: b.x, y: b.y, w: b.w, h: Number.isFinite(b.h) ? b.h : null }
	} catch {
		// unreadable or blocked: the default placement
	}
	return DEFAULT_BOX
}

// The layer legend over the board: every layer with its colour and an eye to show / hide it; clicking
// a layer makes it the current one (highlighted). Its head shows the layer mode and the board side,
// each a button that changes it.
export function LayerLegend({ scene, state, onChange, shifted }: { scene: PcbScene; state: LayerState; onChange(next: LayerState): void; shifted: boolean }) {
	const [open, setOpen] = useState(true)
	// Mechanical layers are many and mostly off: folded until asked for.
	const [folded, setFolded] = useState<Set<string>>(() => new Set(["mech"]))
	const fold = (group: string) =>
		setFolded(prev => {
			const next = new Set(prev)
			if (next.has(group)) next.delete(group)
			else next.add(group)
			return next
		})
	const list = useRef<HTMLDivElement>(null)
	// The current layer stays in view as it changes (keys, Ctrl+Shift+wheel).
	useEffect(() => {
		list.current?.querySelector(".pcb-legend-row.current")?.scrollIntoView({ block: "nearest" })
	}, [state.current, open])

	// Placement: dragged by its head, resized by its right and bottom edges, kept in this browser.
	const [box, setBox] = useState<LegendBox>(storedBox)
	const section = useRef<HTMLElement>(null)
	useEffect(() => {
		try {
			localStorage.setItem(BOX_KEY, JSON.stringify(box))
		} catch {
			// storage blocked: the placement lasts this visit only
		}
	}, [box])
	const offset = shifted ? PANEL_WIDTH : 0
	// Double-clicking the head sends it back to where it started, gliding there: the box jumps to its
	// default, and the move is animated from where it was (measured before) to where it lands.
	const glideFrom = useRef<Keyframe | null>(null)
	const resetPlace = (e: ReactMouseEvent) => {
		if ((e.target as Element).closest("button") || !section.current) return
		const el = section.current
		glideFrom.current = { left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px` }
		setBox(DEFAULT_BOX)
	}
	useLayoutEffect(() => {
		const from = glideFrom.current
		const el = section.current
		if (!from || !el) return
		glideFrom.current = null
		const to = { left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px` }
		el.animate([from, to], { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" })
	}, [box])
	// Pointer drags for moving (head) and resizing (edges), within the board area.
	const startDrag = (e: ReactPointerEvent, what: "move" | "right" | "bottom" | "corner") => {
		if (what === "move" && (e.target as Element).closest("button")) return
		const el = section.current
		const area = el?.offsetParent as HTMLElement | null
		if (!el || !area) return
		e.preventDefault()
		e.stopPropagation()
		const target = e.currentTarget as HTMLElement
		target.setPointerCapture(e.pointerId)
		const start = { px: e.clientX, py: e.clientY, ...box, w: el.offsetWidth, h: el.offsetHeight }
		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - start.px, dy = ev.clientY - start.py
			const maxX = area.clientWidth - offset - start.w, maxY = area.clientHeight - 40
			if (what === "move") setBox(b => ({ ...b, x: clamp(start.x + dx, 0, Math.max(0, maxX)), y: clamp(start.y + dy, 0, Math.max(0, maxY)) }))
			else
				setBox(b => ({
					...b,
					w: what === "bottom" ? b.w : clamp(start.w + dx, MIN_W, area.clientWidth - offset - b.x),
					h: what === "right" ? b.h : clamp(start.h + dy, MIN_H, area.clientHeight - b.y),
				}))
		}
		const up = () => {
			target.removeEventListener("pointermove", move)
			target.removeEventListener("pointerup", up)
			target.removeEventListener("pointercancel", up)
		}
		target.addEventListener("pointermove", move)
		target.addEventListener("pointerup", up)
		target.addEventListener("pointercancel", up)
	}

	return (
		<section
			ref={section}
			className={`pcb-legend${open ? "" : " folded"}${box.h !== null && open ? " sized" : ""}`}
			aria-label="Layers"
			style={{ left: box.x + offset, top: box.y, width: box.w, height: open && box.h !== null ? box.h : undefined }}
		>
			<div className="pcb-legend-head" onPointerDown={e => startDrag(e, "move")} onDoubleClick={resetPlace}>
				<button className="pcb-legend-chip" aria-label={`Layer mode: ${MODE_NAMES[state.mode]}`} data-mode={state.mode} onClick={() => onChange(nextMode(state))}>
					{MODE_NAMES[state.mode]}
				</button>
				<button className={`pcb-legend-chip${state.flip ? " on" : ""}`} aria-pressed={state.flip} onClick={() => onChange({ ...state, flip: !state.flip })}>
					<FlipHorizontal2 size={13} />
					Flip
				</button>
				<span className="grow" />
				<button className="pcb-legend-toggle" aria-label={open ? "Collapse layers" : "Expand layers"} onClick={() => setOpen(!open)}>
					{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
				</button>
			</div>
			{open && (
				<div className="pcb-legend-list" ref={list}>
					{GROUP_ORDER.map(group => {
						const layers = scene.layers.filter(l => l.group === group)
						if (layers.length === 0) return null
						// A folded group still shows its current layer.
						const isFolded = folded.has(group)
						const rows = isFolded ? layers.filter(l => l.key === state.current) : layers
						return (
							<div key={group} className="pcb-legend-group" role="group" aria-label={GROUP_NAMES[group]}>
								<button className="pcb-legend-group-name" aria-expanded={!isFolded} onClick={() => fold(group)}>
									{isFolded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
									{GROUP_NAMES[group]}
									{isFolded && <span className="count">{layers.length}</span>}
								</button>
								{rows.map(l => {
									const on = state.visible.has(l.key)
									const current = state.current === l.key
									const dim = state.mode === "only" ? !current : !on
									return (
										<div
											key={l.key}
											className={`pcb-legend-row${current ? " current" : ""}${dim ? " off" : ""}`}
											data-layer={l.key}
											aria-current={current || undefined}
											onClick={() => onChange(makeCurrent(state, l.key))}
										>
											<span className="swatch" style={{ background: l.color }} />
											<span className="name">{l.name}</span>
											<button
												className="eye"
												aria-label={`${on ? "Hide" : "Show"} ${l.name}`}
												onClick={e => {
													e.stopPropagation()
													onChange(toggleVisible(state, l.key))
												}}
											>
												{on ? <Eye size={13} /> : <EyeOff size={13} />}
											</button>
										</div>
									)
								})}
							</div>
						)
					})}
				</div>
			)}
			{open && (
				<div className="pcb-legend-keys">
					<span>
						<kbd>Shift</kbd>+<kbd>S</kbd> mode
					</span>
					<span>
						<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+wheel layer
					</span>
					<span>
						<kbd>F</kbd> flip
					</span>
				</div>
			)}
			{open && (
				<>
					<div className="pcb-legend-resize right" onPointerDown={e => startDrag(e, "right")} />
					<div className="pcb-legend-resize bottom" onPointerDown={e => startDrag(e, "bottom")} />
					<div className="pcb-legend-resize corner" onPointerDown={e => startDrag(e, "corner")} />
				</>
			)}
		</section>
	)
}
