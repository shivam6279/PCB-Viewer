import { create } from "zustand"
import type { ProjectSummary } from "../model/load-project"
import type { ProjectData } from "../parse/project-data"
import type { ProjectSource } from "../source/types"
import type { Parser } from "../parse/parser"
import type { FileChange } from "../diff/diff"

export type ViewTab = "sch" | "pcb" | "3d" | "bom"

export type Screen =
	| { kind: "start"; error: string | null }
	| { kind: "pick"; source: ProjectSource; handle: FileSystemDirectoryHandle | null; projects: string[] }
	| { kind: "loading"; label: string }
	| { kind: "ghProject"; owner: string; repo: string; prjPath: string; branch: string | null; error: string | null }
	| {
			kind: "viewer"
			source: ProjectSource
			project: ProjectSummary
			tab: ViewTab
			activeSheetId: string | null
			activePcbPath: string | null
	  }

// One thing is selected at a time. A net stays selected across sheets.
// PCB-only selections: one board object (pad, track, via…), a net or component the schematic does not have.
export type Selection =
	| { kind: "net"; netId: number }
	| { kind: "component"; id: string }
	| { kind: "pcbObject"; id: number }
	| { kind: "pcbNet"; name: string }
	| { kind: "pcbComponent"; index: number }

// A request for the schematic view to frame some objects of a sheet instance (after a jump).
export interface Focus {
	instanceId: string
	objects: number[]
	seq: number
}

export type ViewerScreen = Extract<Screen, { kind: "viewer" }>

export type CompareMode = "primary" | "secondary" | "diff"

// A second commit of the open project, shown instead of it (secondary) or beside it (diff). It has a
// parse worker of its own: a worker holds one project's compiled state.
export interface Compare {
	sha: string
	parser: Parser & { dispose?(): void }
	source: ProjectSource | null // null until listed
	project: ProjectSummary | null // null until loaded
	data: ProjectDataState
	files: Map<string, FileChange> | null // document path -> how it differs from the primary
	mode: CompareMode
	error: string | null
}

export type ProjectDataState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ProjectData }

interface AppState {
	screen: Screen
	// The viewer left for the home screen: kept whole (tab, sheet, selection, camera, loaded data) so
	// it can be returned to; opening another project replaces it.
	parked: ViewerScreen | null
	compare: Compare | null
	projectData: ProjectDataState
	selection: Selection | null
	focus: Focus | null
	pcbFocusSeq: number // bumped when the PCB view should frame the selection
	pcbPanelOpen: boolean
	pcbStackupOpen: boolean
	view3dFocusSeq: number // bumped when the 3D view should frame the selection
	view3dPanelOpen: boolean
	view3dPrepared: boolean // the 3D data is in: the 3D view may be built ahead, hidden
	view3dProjection: Projection3d // remembered in this browser
	setScreen(screen: Screen): void
	returnToViewer(): void
	setCompare(compare: Compare | null): void
	updateCompare(patch: Partial<Compare>): void
	setCompareMode(mode: CompareMode): void
	showProject(source: ProjectSource, project: ProjectSummary): void
	setTab(tab: ViewTab): void
	selectSheet(id: string): void
	selectPcb(path: string): void
	setProjectData(state: ProjectDataState): void
	select(selection: Selection | null): void
	// Opens a sheet instance framed on some of its objects, keeping (or setting) the selection.
	jumpTo(instanceId: string, objects: number[], selection?: Selection | null): void
	// Shows the PCB view framed on a selection.
	showOnPcb(selection: Selection): void
	setPcbPanelOpen(open: boolean): void
	setPcbStackupOpen(open: boolean): void
	// Shows the 3D view framed on a selection.
	showOn3d(selection: Selection): void
	setView3dPanelOpen(open: boolean): void
	setView3dPrepared(prepared: boolean): void
	setView3dProjection(projection: Projection3d): void
}

export type Projection3d = "perspective" | "orthographic"
const PROJECTION_KEY = "view3d.projection"

function storedProjection(): Projection3d {
	try {
		return localStorage.getItem(PROJECTION_KEY) === "orthographic" ? "orthographic" : "perspective"
	} catch {
		return "perspective"
	}
}

let focusSeq = 0

export const useAppStore = create<AppState>((set, get) => {
	const updateViewer = (patch: Partial<Extract<Screen, { kind: "viewer" }>>) => {
		const s = get().screen
		if (s.kind === "viewer") set({ screen: { ...s, ...patch } })
	}
	return {
		screen: { kind: "start", error: null },
		parked: null,
		compare: null,
		projectData: { status: "loading" },
		selection: null,
		focus: null,
		pcbFocusSeq: 0,
		pcbPanelOpen: false, // the Layers/Objects panel starts closed; its doc-bar button toggles it
		pcbStackupOpen: false,
		view3dFocusSeq: 0,
		view3dPanelOpen: false,
		view3dPrepared: false,
		view3dProjection: storedProjection(),
		setScreen(screen) {
			const current = get().screen
			set({ screen, parked: screen.kind === "viewer" ? null : current.kind === "viewer" ? current : get().parked })
		},
		setCompare(compare) {
			const old = get().compare
			if (old && old.parser !== compare?.parser) old.parser.dispose?.()
			set({ compare })
		},
		updateCompare(patch) {
			const c = get().compare
			if (c) set({ compare: { ...c, ...patch } })
		},
		setCompareMode(mode) {
			const c = get().compare
			// Object ids differ between the two commits: a selection doesn't carry over.
			if (c && c.mode !== mode) set({ compare: { ...c, mode }, selection: null, focus: null })
		},
		returnToViewer() {
			const parked = get().parked
			if (parked) set({ screen: parked, parked: null })
		},
		showProject(source, project) {
			const firstSheet = project.hierarchy[0]?.id ?? null
			const firstPcb = project.documents.find(d => d.kind === "pcb" && d.exists)?.path ?? null
			set({
				screen: { kind: "viewer", source, project, tab: firstSheet ? "sch" : "pcb", activeSheetId: firstSheet, activePcbPath: firstPcb },
				parked: null,
				projectData: { status: "loading" },
				selection: null,
				focus: null,
				view3dPrepared: false,
			})
		},
		setTab: tab => updateViewer({ tab }),
		selectSheet: id => updateViewer({ tab: "sch", activeSheetId: id }),
		selectPcb: path => updateViewer({ tab: "pcb", activePcbPath: path }),
		setProjectData: projectData => set({ projectData }),
		select: selection => set({ selection }),
		showOnPcb(selection) {
			set({ selection, pcbFocusSeq: get().pcbFocusSeq + 1 })
			updateViewer({ tab: "pcb" })
		},
		setPcbPanelOpen: pcbPanelOpen => set({ pcbPanelOpen }),
		setPcbStackupOpen: pcbStackupOpen => set({ pcbStackupOpen }),
		showOn3d(selection) {
			set({ selection, view3dFocusSeq: get().view3dFocusSeq + 1 })
			updateViewer({ tab: "3d" })
		},
		setView3dPanelOpen: view3dPanelOpen => set({ view3dPanelOpen }),
		setView3dPrepared: view3dPrepared => set({ view3dPrepared }),
		setView3dProjection(view3dProjection) {
			try {
				localStorage.setItem(PROJECTION_KEY, view3dProjection)
			} catch {
				// storage blocked: the choice lasts this visit only
			}
			set({ view3dProjection })
		},
		jumpTo(instanceId, objects, selection) {
			if (selection !== undefined) set({ selection })
			set({ focus: { instanceId, objects, seq: ++focusSeq } })
			updateViewer({ tab: "sch", activeSheetId: instanceId })
		},
	}
})
