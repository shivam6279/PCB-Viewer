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

// What the primary pane of a diff paints over its view, against the secondary: green what only it
// has, red what only the secondary has (drawn where it is there). The secondary is shown plain.
export interface PaneMark {
	ids: Set<number> // schematic: the records only this commit has
	ghosts: string[] // schematic: the secondary's records this commit lacks, as the secondary draws them
	moves?: { members: number[]; dx: number; dy: number }[] // schematic: blocks moved together (their records here; dx, dy to where they are in the other)
	mostly: boolean // most of it changed: say so instead of painting everything
	dim: boolean // deltas only: everything else greyed
	artwork?: ArtworkMark
}

// PCB: the artwork that differs (each piece with its layer), the parts moved, added or removed (their
// outlines: green where a part is, red where it was), the blocks moved together, every changed area and
// the one picked last.
export interface ArtworkMark {
	pieces: { layer: string; rings: number[][]; tone: "added" | "removed"; big: boolean }[] // big: a cell or more across
	parts: { box: number[]; tone: "added" | "removed"; side: "top" | "bottom" }[]
	moves: { here: number[]; there: number[]; layers: string[] }[] // blocks moved together: their extent here and in the other commit
	areas: { box: [number, number, number, number] }[]
	focus: { area: number; seq: number } | null
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
