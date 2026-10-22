// Comparing two commits: the differences of the commit shown (base) against the other one, as marks
// for its views: green what only it has, red what only the other has (drawn where the other has it).
import { useEffect, useState } from "react"
import { wrap } from "comlink"
import type { PaneMark } from "./pane"
import type { ProjectDataState, ViewTab } from "./store"
import { diffByKey, mostlyChanged, schGroupKey, type FileChange } from "../diff/diff"
import type { ArtworkDiff } from "../diff/artwork"
import type { ArtworkWorkerApi } from "../diff/artwork.worker"
import { ARTWORK_DRILLS, ARTWORK_OUTLINE } from "../diff/artwork-keys"
import { findMoves, type Movable } from "../diff/moves"
import { schMovable } from "../diff/sch-moves"
import { channelOf, flattenHierarchy, type HierarchyNode } from "../model/hierarchy"
import type { ProjectSummary } from "../model/load-project"
import type { Parser } from "../parse/parser"
import type { PcbScene } from "../pcb/scene"
import { pcbScene } from "../pcb/use-scene"
import { loadSheet } from "../sch/SchematicView"
import type { ProjectSource } from "../source/types"

export interface DeltaSide {
	sha: string
	source: ProjectSource
	project: ProjectSummary
	parser: Parser
	data: ProjectDataState
}

// The marks for the base's views, what the doc bar says, and (PCB) each changed place for its list.
export type Deltas = { mark: PaneMark | null; note: string | null; areas?: AreaRow[] } | null // null: still working out

export interface AreaRow {
	kind: string // moved | added | removed | changed | layer
	label: string // what changed
	detail: string // where: layers, size
	box: [number, number, number, number]
}

const UNCHANGED: Deltas = { mark: null, note: "No changes in this file" }

// files: how each document of the secondary differs from the primary's; flip: the base is the secondary.
export function useDeltas(tab: ViewTab, activeSheetId: string | null, activePcbPath: string | null, base: DeltaSide | null, other: DeltaSide | null, files: Map<string, FileChange> | null, flip: boolean): Deltas {
	const nodeOf = (s: DeltaSide | null) => (s && activeSheetId ? (flattenHierarchy(s.project.hierarchy).find(n => n.id === activeSheetId) ?? null) : null)
	const nodeBase = nodeOf(base), nodeOther = nodeOf(other)
	const pcbOf = (s: DeltaSide | null) => s?.project.documents.find(d => d.path === activePcbPath && d.exists) ?? s?.project.documents.find(d => d.kind === "pcb" && d.exists) ?? null
	const pcbBase = pcbOf(base), pcbOther = pcbOf(other)
	const schChange = nodeBase?.docPath ? files?.get(nodeBase.docPath) : nodeOther?.docPath ? files?.get(nodeOther.docPath) : undefined
	const pcbChange = pcbBase ? files?.get(pcbBase.path) : pcbOther ? files?.get(pcbOther.path) : undefined
	const sch = useSchDeltas(tab === "sch" ? base : null, nodeBase, other, nodeOther, schChange, flip)
	const pcb = usePcbDeltas(tab === "pcb" ? base : null, other, pcbChange, flip)
	if (!base || !other) return { mark: null, note: null }
	return tab === "sch" ? sch : tab === "pcb" ? pcb : { mark: null, note: null }
}

// The sheet's record groups on each side, fingerprinted by how they draw: the base's own, and the
// other's (as it draws them) that the base lacks.
function useSchDeltas(base: DeltaSide | null, nodeBase: HierarchyNode | null, other: DeltaSide | null, nodeOther: HierarchyNode | null, change: FileChange | undefined, flip: boolean): Deltas {
	const [deltas, setDeltas] = useState<Deltas>(null)
	useEffect(() => {
		if (!base || !other) return
		// change is the secondary's against the primary: "added" is a sheet only the secondary has.
		const onlyHere = flip ? "added" : "removed"
		if (!nodeBase?.docPath || !nodeOther?.docPath) return setDeltas({ mark: null, note: !nodeOther?.docPath ? "Only in this commit" : change === onlyHere ? "Not in this commit" : null })
		if (!change) return setDeltas(UNCHANGED)
		let live = true
		setDeltas(null)
		const groups = async (s: DeltaSide, n: HierarchyNode) => {
			const sheet = await loadSheet(s.source, s.project, n.docPath!, channelOf(s.project.hierarchy, n.id), s.parser)
			const doc = new DOMParser().parseFromString(sheet.markup, "image/svg+xml")
			return {
				width: sheet.viewBox.w,
				list: [...doc.querySelectorAll("g[data-i]")].map(g => ({ i: Number(g.getAttribute("data-i")), key: schGroupKey(g.getAttribute("data-k") ?? "", g.outerHTML), markup: g.outerHTML })),
			}
		}
		Promise.all([groups(base, nodeBase), groups(other, nodeOther)]).then(
			([{ list: gb, width }, { list: go }]) => {
				if (!live) return
				const d = diffByKey(gb, go, g => g.key)
				// Records moved together (a part with its pins and texts, a block of wiring): one move each.
				const strip = (m: string) => m.replace(/\sdata-(?:i|o|ci)="[^"]*"/g, "")
				const movable = (list: typeof gb, only: Set<number>) => {
					const items: { at: number; m: Movable }[] = []
					for (const k of only) {
						const m = schMovable(strip(list[k]!.markup))
						if (m) items.push({ at: k, m })
					}
					return items
				}
				const mb = movable(gb, d.onlyA), mo = movable(go, d.onlyB)
				const found = findMoves(mb.map(x => x.m), mo.map(x => x.m), { min: 3, gap: width * 0.03, step: 0.1 })
				const movedB = new Set<number>(), movedO = new Set<number>()
				const moves = found.map(g => {
					for (const k of g.a) movedB.add(mb[k]!.at)
					for (const k of g.b) movedO.add(mo[k]!.at)
					return { members: g.a.map(k => gb[mb[k]!.at]!.i), dx: g.dx, dy: g.dy }
				})
				const ids = [...d.onlyA].filter(k => !movedB.has(k)).map(k => gb[k]!.i)
				const ghosts = [...d.onlyB].filter(k => !movedO.has(k)).map(k => go[k]!.markup)
				const n = ids.length + ghosts.length + moves.length
				setDeltas({
					mark: { ids: new Set(ids), ghosts, moves, mostly: mostlyChanged(d), dim: false },
					note: mostlyChanged(d) ? "Most of it changed" : n === 0 ? "No differences" : `${n} difference${n === 1 ? "" : "s"}${moves.length ? ` (${moves.length} moved)` : ""}`,
				})
			},
			() => live && setDeltas({ mark: null, note: "Couldn't compare this sheet" }),
		)
		return () => {
			live = false
		}
	}, [base, other, nodeBase, nodeOther, change, flip])
	return deltas
}

// Each pair of boards compared once, primary against secondary (either side shown reads the same
// result; switching tabs comes back to it), on a worker of its own, closed once it answers.
const compared = new WeakMap<PcbScene, WeakMap<PcbScene, Promise<ArtworkDiff>>>()
function diffBoards(a: PcbScene, b: PcbScene): Promise<ArtworkDiff> {
	let byB = compared.get(a)
	if (!byB) compared.set(a, (byB = new WeakMap()))
	let pending = byB.get(b)
	if (!pending) {
		const worker = new Worker(new URL("../diff/artwork.worker.ts", import.meta.url), { type: "module" })
		const result = wrap<ArtworkWorkerApi>(worker).diff(a, b)
		const entries = byB
		result.finally(() => worker.terminate()).catch(() => entries.delete(b))
		byB.set(b, (pending = result))
	}
	return pending
}

const layerName = (key: string, s: PcbScene) => (key === ARTWORK_DRILLS ? "Drills" : key === ARTWORK_OUTLINE ? "Board shape" : (s.layers.find(l => l.key === key)?.name ?? key))
const list = (names: string[]) => `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`

// The boards compared (primary A against secondary B), read from the base's side: pieces and parts it
// has green, the other's red; parts and layers "added" when only the base has them.
function usePcbDeltas(base: DeltaSide | null, other: DeltaSide | null, change: FileChange | undefined, flip: boolean): Deltas {
	const [deltas, setDeltas] = useState<Deltas>(null)
	const dataBase = base?.data.status === "ready" ? base.data.data : null
	const dataOther = other?.data.status === "ready" ? other.data.data : null
	useEffect(() => {
		if (!base || !other) return
		if (!change) return setDeltas(UNCHANGED)
		if (!dataBase || !dataOther) return setDeltas(null)
		let live = true
		setDeltas(null)
		Promise.all([pcbScene(base.parser, dataBase), pcbScene(other.parser, dataOther)])
			.then(async ([sBase, sOther]) => {
				if (!live) return
				if (!sBase || !sOther) return setDeltas({ mark: null, note: sBase ? "No board in the other commit" : "No board in this commit" })
				const [sa, sb] = flip ? [sOther, sBase] : [sBase, sOther]
				const d = await diffBoards(sa, sb)
				if (!live) return
				if (!d.areas.length) return setDeltas({ mark: null, note: "No change to the board's artwork" })
				const own = flip ? "b" : "a"
				const turn = <K extends string>(kind: K): K => (flip ? ((kind === "added" ? "removed" : kind === "removed" ? "added" : kind) as K) : kind)
				const parts = d.parts.flatMap(p => {
					const here = flip ? p.b : p.a, there = flip ? p.a : p.b
					const hereSide = (flip ? p.sideB : p.sideA) ?? "top", thereSide = (flip ? p.sideA : p.sideB) ?? "top"
					return [...(here ? [{ box: here, tone: "added" as const, side: hereSide }] : []), ...(there ? [{ box: there, tone: "removed" as const, side: thereSide }] : [])]
				})
				const mark: PaneMark = {
					ids: new Set(),
					ghosts: [],
					mostly: false,
					dim: false,
					artwork: {
						pieces: d.pieces.map(p => ({ layer: p.layer, rings: p.rings, tone: p.side === own ? "added" : "removed", big: !!p.cells })),
						parts,
						moves: d.moves.map(m => ({ here: flip ? m.b : m.a, there: flip ? m.a : m.b, layers: m.layers })),
						areas: d.areas.map(c => ({ box: c.box })),
						focus: null,
					},
				}
				const rows = d.areas.map((c): AreaRow => {
					if (c.move !== undefined) {
						// Shown from the base: where it is here less where it is in the other.
						const m = d.moves[c.move]!
						const sx = flip ? m.dx : -m.dx, sy = flip ? m.dy : -m.dy
						const named = m.parts.length ? `${list(m.parts)} · ` : ""
						return { kind: "moved", label: `${named}${m.count} items moved ${+sx.toFixed(1)}, ${+sy.toFixed(1)} mil`, detail: `${m.layers.map(k => layerName(k, sa)).join(", ")} · ${Math.round(m.a[2] - m.a[0])} × ${Math.round(m.a[3] - m.a[1])} mil`, box: c.box }
					}
					if (c.layer) {
						const l = c.layer
						const label = l.kind === "renamed" ? (flip ? `Layer ${l.name} renamed ${l.was}` : `Layer ${l.was} renamed ${l.name}`) : `Layer ${l.name} ${turn(l.kind)}`
						return { kind: "layer", label, detail: "", box: c.box }
					}
					const mine = flip ? c.b : c.a, theirs = flip ? c.a : c.b
					const byKind = (["moved", "added", "removed"] as const).map(kind => ({ kind, names: c.parts.map(k => d.parts[k]!).filter(p => turn(p.kind) === kind).map(p => p.designator) }))
					const named = byKind.filter(k => k.names.length).map(k => `${list(k.names)} ${k.kind}`)
					const kinds = new Set(byKind.filter(k => k.names.length).map(k => k.kind))
					const kind = !mine && !theirs && kinds.size === 1 ? [...kinds][0]! : mine && !theirs && !c.parts.length ? "added" : theirs && !mine && !c.parts.length ? "removed" : "changed"
					const names = c.layers.map(k => layerName(k, sa))
					const on = names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ")
					const [x0, y0, x1, y1] = c.box
					return { kind, label: [...named, c.what].filter(Boolean).join(" · ") || "Artwork", detail: [on, `${Math.round(x1 - x0)} × ${Math.round(y1 - y0)} mil`].filter(Boolean).join(" · "), box: c.box }
				})
				setDeltas({ mark, note: `${rows.length} change${rows.length === 1 ? "" : "s"}`, areas: rows })
			})
			.catch(() => live && setDeltas({ mark: null, note: "Couldn't compare the boards" }))
		return () => {
			live = false
		}
	}, [base, other, dataBase, dataOther, change, flip])
	return deltas
}
