// The ruler while it is on, in one view. Distance / X / Y: a click for the first point, a click for
// the second (snapped, unless Ctrl is held); Radius / Diameter: one click on a circle. Then a last
// click places the dimension line (it follows the cursor till then). Space cycles the kind of the
// same sort meanwhile (distance, X, Y; radius, diameter). The view supplies where screen points land
// (the host) and redraws.
import { useAppStore } from "../app/store"
import { TEXT_PX } from "./draw"
import { isCircle, nextMode, SNAP_NAMES, type Measure, type MeasureMode, type MeasurePoint, type Vec3 } from "./measure"

export interface ToolHost {
	point(clientX: number, clientY: number, free: boolean): MeasurePoint | null
	// The circle under a point: its centre and the rim point nearest the cursor.
	circle(clientX: number, clientY: number): { a: MeasurePoint; b: MeasurePoint } | null
	// Where a dimension line being placed goes, for a measurement of these points.
	place(clientX: number, clientY: number, m: { mode: MeasureMode; a: MeasurePoint; b: MeasurePoint }): Vec3 | null
	// How long a mil shows on screen at a point now (CSS px), square to the line of sight.
	scaleAt(p: Vec3): number
	redraw(): void
}

type Live = Pick<Measure, "id" | "view" | "mode" | "a" | "b" | "place">

export class MeasureTool {
	first: MeasurePoint | null = null // the first point, once clicked
	picked: { a: MeasurePoint; b: MeasurePoint } | null = null // what is measured, while it is being placed
	cursor: MeasurePoint | null = null // where the next point click would land
	private hoverCircle: { a: MeasurePoint; b: MeasurePoint } | null = null
	private placeAt: Vec3 | null = null
	private last: { x: number; y: number; free: boolean } | null = null

	constructor(
		private readonly view: Measure["view"],
		private readonly host: ToolHost,
	) {}

	// The kind of measurement, as last seen: changed (in the bar) to one of the other sort, what was
	// begun is dropped.
	private seen: MeasureMode = useAppStore.getState().measureMode
	private get mode() {
		const now = useAppStore.getState().measureMode
		if (now !== this.seen) {
			if (isCircle(now) !== isCircle(this.seen)) {
				this.first = null
				this.picked = null
				this.placeAt = null
			}
			this.seen = now
		}
		return now
	}

	// The measurement being made, to draw (id -1): being placed, being stretched to its second point,
	// or (Radius / Diameter) the circle under the cursor.
	get live(): Live | null {
		const base = { id: -1, view: this.view, mode: this.mode }
		if (this.picked) return { ...base, ...this.picked, place: this.placeAt }
		if (this.first && this.cursor) return { ...base, a: this.first, b: this.cursor, place: null }
		if (isCircle(this.mode) && this.hoverCircle) return { ...base, ...this.hoverCircle, place: null }
		return null
	}

	// What the cursor would snap to, in a few words ("Centre · Pad U3-4 (GND)"), or (not snapped) what it is
	// over, if anything.
	get note(): string | null {
		const p = this.cursor
		if (!p) return null
		if (p.snap) return p.on ? `${SNAP_NAMES[p.snap]} · ${p.on}` : SNAP_NAMES[p.snap]
		return p.on
	}

	// Whether the cursor shows a snap marker (not while placing or picking a circle).
	get marking() {
		const circle = isCircle(this.mode)
		return !this.picked && !circle
	}

	move(clientX: number, clientY: number, free: boolean) {
		this.last = { x: clientX, y: clientY, free }
		const mode = this.mode
		if (this.picked) this.placeAt = this.host.place(clientX, clientY, { mode, ...this.picked })
		else if (isCircle(mode)) this.hoverCircle = this.host.circle(clientX, clientY)
		else this.cursor = this.host.point(clientX, clientY, free)
		this.publishNote()
		this.host.redraw()
	}

	// What the cursor would snap to, for the ruler's key (only when it changes).
	private publishNote() {
		const note = this.marking ? this.note : isCircle(this.mode) && !this.picked && this.hoverCircle ? this.hoverCircle.a.on : null
		if (useAppStore.getState().snapNote !== note) useAppStore.setState({ snapNote: note })
	}

	// Ctrl pressed or let go (or the kind changed) without moving: the same place again.
	refresh(free = this.last?.free ?? false) {
		if (this.last) this.move(this.last.x, this.last.y, free)
		else this.host.redraw()
	}

	leave() {
		this.last = null
		this.cursor = null
		this.hoverCircle = null
		this.publishNote()
		this.host.redraw()
	}

	click(clientX: number, clientY: number, free: boolean) {
		const store = useAppStore.getState()
		const mode = this.mode
		if (this.picked) {
			const place = this.host.place(clientX, clientY, { mode, ...this.picked })
			// Its text's size on the board at this zoom: its smallest from now on.
			const { a, b } = this.picked
			const perMil = this.host.scaleAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 })
			const minText = perMil > 0 ? TEXT_PX / perMil : undefined
			const id = store.addMeasure({ view: this.view, mode, ...this.picked, place, minText })
			store.select({ kind: "measure", id })
			this.picked = null
			this.placeAt = null
		} else if (isCircle(mode)) {
			const c = this.host.circle(clientX, clientY)
			if (!c) return
			this.picked = c
			this.placeAt = null
		} else {
			const p = this.host.point(clientX, clientY, free)
			if (!p) return
			if (!this.first) this.first = p
			else {
				this.picked = { a: this.first, b: p }
				this.first = null
				this.placeAt = null
			}
			this.cursor = p
		}
		this.refresh(free)
	}

	// Space, while measuring: the next kind of the same sort.
	cycle(): boolean {
		const store = useAppStore.getState()
		store.setMeasureMode(nextMode(store.measureMode))
		this.refresh()
		return true
	}

	// Esc: drops the measurement being made (true), or there is none (false).
	cancel(): boolean {
		if (!this.first && !this.picked) return false
		this.first = null
		this.picked = null
		this.placeAt = null
		this.refresh()
		return true
	}

	reset() {
		if (useAppStore.getState().snapNote !== null) useAppStore.setState({ snapNote: null })
		this.first = null
		this.picked = null
		this.placeAt = null
		this.cursor = null
		this.hoverCircle = null
		this.last = null
	}
}

// The ruler's keys, the same in both views: M turns it on or off; while it is on, R switches between
// two-point measurements and Radius / Diameter, Space cycles the kind within its sort, and Esc drops the
// one being made (or, with none, turns the ruler off); Delete removes a selected measurement. True
// when the key was the ruler's.
export function measureKey(e: KeyboardEvent, tool: MeasureTool): boolean {
	if (e.ctrlKey || e.metaKey || e.altKey) return false
	const store = useAppStore.getState()
	if (e.code === "KeyM" && !e.shiftKey && !e.repeat) {
		e.preventDefault()
		store.setMeasuring(!store.measuring)
		return true
	}
	if (store.measuring && e.code === "KeyR" && !e.shiftKey && !e.repeat) {
		e.preventDefault()
		store.setMeasureMode(isCircle(store.measureMode) ? "distance" : "radius")
		tool.refresh()
		return true
	}
	if (store.measuring && e.code === "Space") {
		e.preventDefault()
		tool.cycle()
		return true
	}
	if (store.measuring && e.key === "Escape") {
		if (!tool.cancel()) store.setMeasuring(false)
		return true
	}
	const sel = store.selection
	if ((e.key === "Delete" || e.key === "Backspace") && sel?.kind === "measure") {
		e.preventDefault()
		store.removeMeasure(sel.id)
		return true
	}
	return false
}
