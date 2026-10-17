import { ChevronDown, ChevronUp, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useAppStore } from "../app/store"
import { snapShape, TARGET_COLOURS } from "./draw"
import { isCircle, MEASURE_MODES, MODE_LABELS, SNAP_KINDS, SNAP_NAMES, SNAP_LABELS, TARGET_NAMES, type Measure, type SnapKind, type SnapTarget } from "./measure"

// The ruler's bar along the bottom of the view while it is on: what is measured (two points: distance,
// X or Y; one click on a circle: radius or diameter; Space cycles within the sort), what points snap
// to (Ctrl held: nothing), clearing this view's measurements, and turning the ruler off.
export function MeasureBar({ view }: { view: Measure["view"] }) {
	const mode = useAppStore(s => s.measureMode)
	const snaps = useAppStore(s => s.snapKinds)
	const count = useAppStore(s => s.measures.filter(m => m.view === view).length)
	const store = useAppStore.getState()
	return (
		<div className="measure-bar" role="toolbar" aria-label="Ruler" onPointerDown={e => e.stopPropagation()}>
			<div className="measure-modes" role="radiogroup" aria-label="Measure">
				{MEASURE_MODES.map((m, i) => (
					<span key={m} className="measure-mode">
						{i > 0 && isCircle(m) && !isCircle(MEASURE_MODES[i - 1]!) && <span className="measure-modes-gap" />}
						<button role="radio" aria-checked={mode === m} onClick={() => store.setMeasureMode(m)}>
							{MODE_LABELS[m]}
						</button>
					</span>
				))}
			</div>
			<span className="measure-key">R · Space</span>
			<span className="measure-sep" />
			<span className="measure-label">Snap</span>
			{SNAP_KINDS.map(k => (
				<button
					key={k}
					className={`measure-chip${snaps.has(k) ? " on" : ""}`}
					aria-pressed={snaps.has(k)}
					onClick={() => {
						const next = new Set(snaps)
						if (next.has(k)) next.delete(k)
						else next.add(k)
						store.setSnapKinds(next)
					}}
				>
					{SNAP_LABELS[k]}
				</button>
			))}
			<span className="measure-key">Ctrl: off</span>
			<span className="measure-sep" />
			<button className="measure-chip" disabled={count === 0} onClick={() => store.clearMeasures(view)}>
				Clear{count > 0 ? ` (${count})` : ""}
			</button>
			<button className="measure-close" aria-label="Close ruler" onClick={() => store.setMeasuring(false)}>
				<X size={14} />
			</button>
		</div>
	)
}

const LEGEND_KEY = "measure.legend"

// The ruler's key, in the view's lower left while the ruler is on: what the cursor would snap to now
// ("Centre · Pad U3-4 (GND)"), what each marker shape means (the kind of point) and each colour (what
// it is on). It folds down to its heading and the current snap; that is remembered.
export function MeasureLegend() {
	const note = useAppStore(s => s.snapNote)
	const [open, setOpen] = useState(() => {
		try {
			return localStorage.getItem(LEGEND_KEY) !== "closed"
		} catch {
			return true
		}
	})
	const toggle = () => {
		setOpen(!open)
		try {
			localStorage.setItem(LEGEND_KEY, open ? "closed" : "open")
		} catch {
			// storage blocked: this visit only
		}
	}
	return (
		<div className="measure-legend" aria-label="Ruler legend" onPointerDown={e => e.stopPropagation()}>
			<button className="measure-legend-head" aria-expanded={open} onClick={toggle}>
				Snap key {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
			</button>
			<div className="measure-legend-now" aria-live="polite">
				{note ?? "Nothing to snap to"}
			</div>
			{open && (
				<div className="measure-legend-body">
					<div className="measure-legend-col">
						<div className="measure-legend-group">Point</div>
						{(SNAP_KINDS as SnapKind[]).map(k => (
							<div key={k} className="measure-legend-row">
								<Glyph kind={k} colour="#e6e6e6" />
								{SNAP_NAMES[k]}
							</div>
						))}
					</div>
					<div className="measure-legend-col">
						<div className="measure-legend-group">On</div>
						{(Object.keys(TARGET_NAMES) as Exclude<SnapTarget, "other">[]).map(t => (
							<div key={t} className="measure-legend-row">
								<i className="measure-legend-swatch" style={{ background: TARGET_COLOURS[t] }} />
								{TARGET_NAMES[t]}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	)
}

// A marker shape, drawn as on the board.
function Glyph({ kind, colour }: { kind: SnapKind; colour: string }) {
	const ref = useRef<HTMLCanvasElement>(null)
	useEffect(() => {
		const el = ref.current
		const ctx = el?.getContext("2d")
		if (!el || !ctx) return
		const ratio = window.devicePixelRatio || 1
		el.width = el.height = Math.round(20 * ratio)
		snapShape(ctx, { x: el.width / 2, y: el.height / 2 }, kind, 6 * ratio, ratio, colour)
	}, [kind, colour])
	return <canvas ref={ref} className="measure-legend-glyph" aria-hidden="true" />
}
