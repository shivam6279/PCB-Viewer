import { create } from "zustand"
import type { ProjectSummary } from "../model/load-project"
import type { ProjectData } from "../parse/project-data"
import type { ProjectSource } from "../source/types"
import type { Parser } from "../parse/parser"
import type { FileChange } from "../diff/diff"
import { DEFAULT_STEP_OPTIONS, type StepEstimate, type StepExportOptions, type StepQuality } from "../3d/step-export/options"
import { SNAP_KINDS, type Measure, type MeasureMode, type SnapKind } from "../measure/measure"

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
	| { kind: "bundle"; bundleId: number } // a bus or signal harness
	| { kind: "component"; id: string }
	| { kind: "pcbObject"; id: number }
	| { kind: "pcbNet"; name: string }
	| { kind: "pcbComponent"; index: number }
	| { kind: "measure"; id: number } // a ruler measurement (PCB or 3D view)

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
	// The assembly variant shown (its name); null = "[No Variations]". A project opens on its first variant.
	variant: string | null
	pcbFocusSeq: number // bumped when the PCB view should frame the selection
	pcbPanelOpen: boolean
	pcbStackupOpen: boolean
	view3dFocusSeq: number // bumped when the 3D view should frame the selection
	view3dPanelOpen: boolean
	view3dPrepared: boolean // the 3D data is in: the 3D view may be built ahead, hidden
	view3dProjection: Projection3d // remembered in this browser
	view3dHidden: Set<string> // parts hidden by hand in the 3D view (partKey), for the open board
	stepExportSeq: number // bumped when the 3D view should export the board as STEP
	stepExportOptions: StepExportOptions // the settings of the last export asked for
	stepExporting: boolean
	stepDialogOpen: boolean
	stepEstimator: ((quality: StepQuality) => Promise<StepEstimate>) | null // the open board's, once the 3D view has it
	// The ruler (PCB and 3D views): on or off, the measurements made on the open board, what points
	// snap to (remembered in this browser) and the kind of measurement the next one starts as.
	measuring: boolean
	netColors: NetColorViews // whether each view draws nets in the project's net colours (N)
	measures: Measure[]
	snapKinds: Set<SnapKind>
	measureMode: MeasureMode
	snapNote: string | null // what the ruler's cursor would snap to now, for the ruler's key
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
	setVariant(variant: string | null): void
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
	setView3dHidden(hidden: Set<string>): void
	requestStepExport(options: StepExportOptions): void
	setStepDialogOpen(open: boolean): void
	setStepExporting(exporting: boolean): void
	setStepEstimator(estimator: ((quality: StepQuality) => Promise<StepEstimate>) | null): void
	setMeasuring(on: boolean): void
	toggleNetColors(view: keyof NetColorViews): void
	addMeasure(m: Omit<Measure, "id">): number
	updateMeasure(id: number, patch: Partial<Omit<Measure, "id">>): void
	removeMeasure(id: number): void
	clearMeasures(view: Measure["view"]): void
	setSnapKinds(kinds: Set<SnapKind>): void
	setMeasureMode(mode: MeasureMode): void
}

// Net colours, per view: on in the schematic, off on the board until asked for. Kept per browser.
export interface NetColorViews {
	sch: boolean
	pcb: boolean
}
const NET_COLORS_KEY = "viewer.netColors"

function storedNetColors(): NetColorViews {
	const out: NetColorViews = { sch: true, pcb: false }
	try {
		const raw = JSON.parse(localStorage.getItem(NET_COLORS_KEY) ?? "null") as Partial<NetColorViews> | null
		if (typeof raw?.sch === "boolean") out.sch = raw.sch
		if (typeof raw?.pcb === "boolean") out.pcb = raw.pcb
	} catch {
		// storage blocked or unreadable: the defaults
	}
	return out
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
let measureSeq = 0

const SNAPS_KEY = "measure.snaps"
function storedSnaps(): Set<SnapKind> {
	try {
		const raw = JSON.parse(localStorage.getItem(SNAPS_KEY) ?? "null") as unknown
		if (Array.isArray(raw)) return new Set(raw.filter((k): k is SnapKind => SNAP_KINDS.includes(k as SnapKind)))
	} catch {
		// storage blocked or garbled: the defaults
	}
	return new Set(SNAP_KINDS)
}

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
		variant: null,
		pcbFocusSeq: 0,
		pcbPanelOpen: false, // the Layers/Objects panel starts closed; its doc-bar button toggles it
		pcbStackupOpen: false,
		view3dFocusSeq: 0,
		view3dPanelOpen: false,
		stepExportSeq: 0,
		stepExportOptions: DEFAULT_STEP_OPTIONS,
		stepExporting: false,
		stepDialogOpen: false,
		stepEstimator: null,
		view3dPrepared: false,
		view3dProjection: storedProjection(),
		view3dHidden: new Set(),
		measuring: false,
		netColors: storedNetColors(),
		measures: [],
		snapKinds: storedSnaps(),
		measureMode: "distance",
		snapNote: null,
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
				variant: project.variants?.[0]?.name ?? null,
				view3dPrepared: false,
				view3dHidden: new Set(),
				measures: [],
			})
		},
		setTab: tab => updateViewer({ tab }),
		selectSheet: id => updateViewer({ tab: "sch", activeSheetId: id }),
		selectPcb(path) {
			const s = get().screen
			if (s.kind === "viewer" && s.activePcbPath !== path) set({ view3dHidden: new Set(), measures: [] })
			updateViewer({ tab: "pcb", activePcbPath: path })
		},
		setProjectData: projectData => set({ projectData }),
		select: selection => set({ selection }),
		setVariant: variant => set({ variant }),
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
		requestStepExport: stepExportOptions => set({ stepExportOptions, stepExportSeq: get().stepExportSeq + 1, stepDialogOpen: false }),
		setStepDialogOpen: stepDialogOpen => set({ stepDialogOpen }),
		setStepExporting: stepExporting => set({ stepExporting }),
		setStepEstimator: stepEstimator => set({ stepEstimator }),
		setView3dPrepared: view3dPrepared => set({ view3dPrepared }),
		setView3dProjection(view3dProjection) {
			try {
				localStorage.setItem(PROJECTION_KEY, view3dProjection)
			} catch {
				// storage blocked: the choice lasts this visit only
			}
			set({ view3dProjection })
		},
		setView3dHidden: view3dHidden => set({ view3dHidden }),
		setMeasuring: measuring => set({ measuring }),
		toggleNetColors(view) {
			const netColors = { ...get().netColors, [view]: !get().netColors[view] }
			try {
				localStorage.setItem(NET_COLORS_KEY, JSON.stringify(netColors))
			} catch {
				// storage blocked: the choice lasts this visit only
			}
			set({ netColors })
		},
		addMeasure(m) {
			const id = ++measureSeq
			set({ measures: [...get().measures, { ...m, id }] })
			return id
		},
		updateMeasure(id, patch) {
			set({ measures: get().measures.map(m => (m.id === id ? { ...m, ...patch } : m)) })
		},
		removeMeasure(id) {
			const sel = get().selection
			set({ measures: get().measures.filter(m => m.id !== id), selection: sel?.kind === "measure" && sel.id === id ? null : sel })
		},
		clearMeasures(view) {
			const sel = get().selection
			const gone = new Set(get().measures.filter(m => m.view === view).map(m => m.id))
			set({ measures: get().measures.filter(m => !gone.has(m.id)), selection: sel?.kind === "measure" && gone.has(sel.id) ? null : sel })
		},
		setSnapKinds(snapKinds) {
			try {
				localStorage.setItem(SNAPS_KEY, JSON.stringify([...snapKinds]))
			} catch {
				// storage blocked: this visit only
			}
			set({ snapKinds })
		},
		setMeasureMode: measureMode => set({ measureMode }),
		jumpTo(instanceId, objects, selection) {
			if (selection !== undefined) set({ selection })
			set({ focus: { instanceId, objects, seq: ++focusSeq } })
			updateViewer({ tab: "sch", activeSheetId: instanceId })
		},
	}
})
