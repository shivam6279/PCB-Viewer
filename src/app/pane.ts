import { createContext, useContext } from "react"
import { useAppStore, type ProjectDataState, type Selection } from "./store"

// Keeps two views of the same kind showing the same place: whichever moves publishes its viewport,
// the other follows. `last` lets a view that mounts second start where the first one is.
export class ViewLink<T> {
	last: { value: T; from: object } | null = null
	private readonly subs = new Set<(value: T, from: object) => void>()

	publish(value: T, from: object): void {
		this.last = { value, from }
		for (const s of this.subs) s(value, from)
	}

	subscribe(fn: (value: T, from: object) => void): () => void {
		this.subs.add(fn)
		return () => this.subs.delete(fn)
	}
}

// What a diff pane paints over its view: the objects found in only this side's commit (PCB object ids,
// or schematic record indices), red where they were removed, green where added.
export interface PaneMark {
	ids: Set<number>
	tone: "removed" | "added"
	mostly: boolean // most of it changed: say so instead of painting everything
	repoured?: number // PCB: changed polygon pours, counted but not painted (any nearby change re-pours them)
}

// One side of a comparison. The default (no provider) is the open project as the store has it.
export interface Pane {
	side: "primary" | "secondary"
	data: ProjectDataState | null // null: the store's
	diff: boolean // side by side: no selection (ids differ between the commits)
	mark: PaneMark | null
	links: { sch: ViewLink<unknown>; pcb: ViewLink<unknown>; view3d: ViewLink<unknown>; layers: ViewLink<unknown> } | null
	panelHost?: HTMLElement | null // side by side: where the (one) layers panel goes, beside both boards
}

export const PaneContext = createContext<Pane>({ side: "primary", data: null, diff: false, mark: null, links: null })

export function usePane() {
	return useContext(PaneContext)
}

export function usePaneData(): ProjectDataState {
	const pane = usePane()
	const store = useAppStore(s => s.projectData)
	return pane.data ?? store
}

export function usePaneSelection(): Selection | null {
	const pane = usePane()
	const selection = useAppStore(s => s.selection)
	return pane.diff ? null : selection
}
