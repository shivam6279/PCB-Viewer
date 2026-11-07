import { lazy, Suspense, useEffect, useMemo } from "react"
import { useAppStore } from "../app/store"
import { openSource } from "../app/open"
import { loadProjectData } from "../app/load-project-data"
import { PaneContext } from "../app/pane"
import { workerParser } from "../parse/worker-parser"
import { MemorySource } from "../source/memory-source"
import { stripExt } from "../source/paths"
import { boardKey } from "../3d/board-key"
import type { BoardEngine } from "../3d/engine"
import type { ProjectSummary } from "../model/load-project"
import type { ProjectSource } from "../source/types"
import type { Rgb } from "../3d/board3d"
import { useEmbed3d } from "./bridge"
import { partShapes } from "./shapes"
import type { Loaded3d } from "../3d/prefetch"

// The 3D view of one board, alone, for a host app's frame: embed.html?pcb=<url of a .PcbDoc>.
//
// Host -> here (postMessage):
//   { type: "parts", states: { [designator]: "placed" | "dnp" }, lit: designator[] | null }
//   { type: "side", side: "top" | "bottom" }   { type: "flip" }   { type: "reset" }   { type: "rotate", on }
//   { type: "shapes" }: each part's size and outline from above (see shapes.ts), answered with
//   { type: "shapes", parts: PartShape[] } once the board's models are in
// Here -> host:
//   { type: "ready" }   { type: "pick", ref: designator | null }   { type: "side", side }   { type: "error", message }
// Parts are named by their board designator (R38_ESC_2). Same origin only.

const View3d = lazy(() => import("../3d/View3d").then(m => ({ default: m.View3d })))

// How each assembly state is drawn: placed parts green, not-fitted parts a faint red ghost
const STATE_TINT: Record<string, { color: Rgb; opacity: number }> = {
	placed: { color: [0.23, 0.6, 0.42], opacity: 1 },
	dnp: { color: [0.88, 0.33, 0.29], opacity: 0.3 },
}

const BACKGROUND: Rgb = [17 / 255, 17 / 255, 19 / 255] // the host's dark viewport (pnpd --viewport #111113)

// The loaded board (scene, bodies, models), for the part shapes
let loaded: Loaded3d | null = null
const loadedWaiters: ((l: Loaded3d) => void)[] = []
function whenLoaded(fn: (l: Loaded3d) => void) {
	if (loaded) fn(loaded)
	else loadedWaiters.push(fn)
}

const post = (msg: unknown) => window.parent !== window && window.parent.postMessage(msg, location.origin)
const engine = () => (document.querySelector(".view3d-canvas") as (HTMLCanvasElement & { __view3d?: BoardEngine }) | null)?.__view3d ?? null

async function openFromUrl(url: string): Promise<void> {
	const r = await fetch(url)
	if (!r.ok) throw new Error(`The board file didn't load (${r.status})`)
	const name = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "board.PcbDoc")
	const file = /\.pcbdoc$/i.test(name) ? name : "board.PcbDoc"
	await openSource(new MemorySource(stripExt(file), [[file, new Uint8Array(await r.arrayBuffer())]]), null)
}

export function Embed() {
	const screen = useAppStore(s => s.screen)
	useEffect(() => {
		const url = new URLSearchParams(location.search).get("pcb")
		if (!url) return void useAppStore.getState().setScreen({ kind: "start", error: "No board given" })
		openFromUrl(url).catch(e => useAppStore.getState().setScreen({ kind: "start", error: e instanceof Error ? e.message : String(e) }))
	}, [])
	useEffect(() => {
		if (screen.kind === "start" && screen.error) post({ type: "error", message: screen.error })
	}, [screen])

	// Clicks go to the host, not into a selection; a flat view by default (left drag pans)
	useEffect(() => {
		useEmbed3d.setState({ onPick: ref => post({ type: "pick", ref }), leftPans: true })
		const onMessage = (e: MessageEvent) => {
			if (e.origin !== location.origin || !e.data || typeof e.data !== "object") return
			const m = e.data as { type: string; [k: string]: unknown }
			const eng = engine()
			if (m.type === "parts") {
				const tints = new Map<string, { color: Rgb; opacity: number }>()
				for (const [ref, state] of Object.entries((m.states ?? {}) as Record<string, string>)) {
					const t = STATE_TINT[state]
					if (t) tints.set(ref, t)
				}
				useEmbed3d.setState({ tints, lit: Array.isArray(m.lit) ? new Set(m.lit as string[]) : null })
			} else if (m.type === "rotate") useEmbed3d.setState({ leftPans: !m.on })
			else if (m.type === "shapes") whenLoaded(l => post({ type: "shapes", parts: partShapes(l) }))
			else if (eng && m.type === "side") eng.showSide(m.side === "bottom" ? "bottom" : "top")
			else if (eng && m.type === "reset") eng.showSide(eng.facing())
			else if (eng && m.type === "flip") {
				eng.flip()
			}
		}
		window.addEventListener("message", onMessage)
		// Ready once the board is built (the host then sends the parts' states)
		let facingTimer: ReturnType<typeof setInterval> | undefined
		const t = setInterval(() => {
			const eng = engine()
			if (eng) {
				clearInterval(t)
				eng.setBackground(BACKGROUND)
				// The side facing the viewer, whenever it changes (Flip, a turn by hand, a side picked). Checked
				// on a timer: a render listener runs before the last frame of an eased turn moves the camera
				let facing = eng.facing()
				facingTimer = setInterval(() => {
					if (eng.facing() !== facing) {
						facing = eng.facing()
						post({ type: "side", side: facing })
					}
				}, 250)
				post({ type: "ready" })
			}
		}, 200)
		return () => {
			window.removeEventListener("message", onMessage)
			clearInterval(t)
			clearInterval(facingTimer)
		}
	}, [])

	if (screen.kind === "viewer") return <EmbedView source={screen.source} project={screen.project} pcbPath={screen.activePcbPath} />
	return (
		<div className="embed">
			<div className="embed-message">{screen.kind === "start" ? (screen.error ?? "No board") : "Loading board…"}</div>
		</div>
	)
}

function EmbedView({ source, project, pcbPath }: { source: ProjectSource; project: ProjectSummary; pcbPath: string | null }) {
	const parser = useMemo(() => workerParser(), [])
	const data = useAppStore(s => s.projectData)
	useEffect(() => void loadProjectData(source, project, parser), [source, project, parser])
	// As the viewer does: the board's own data starts loading at once, the rest once the project is in
	useEffect(() => {
		if (!pcbPath) return
		void import("../3d/prefetch").then(m => m.startBoard3d(boardKey(source, pcbPath), () => source.read(pcbPath)))
	}, [source, pcbPath])
	useEffect(() => {
		if (!pcbPath || data.status !== "ready") return
		void import("../3d/prefetch").then(m =>
			m
				.load3d(parser, data.data, boardKey(source, pcbPath), () => source.read(pcbPath))
				.done.then(l => {
					if (!l) return
					loaded = l
					for (const fn of loadedWaiters.splice(0)) fn(l)
				})
				.catch(() => {}),
		)
	}, [data, parser, source, pcbPath])

	if (!pcbPath) return <div className="embed"><div className="embed-message">No board in this file</div></div>
	return (
		<div className="embed">
			<PaneContext.Provider value={{ side: "primary", data: null, diff: false, mark: null, links: null }}>
				<Suspense fallback={<div className="embed-message">Loading board…</div>}>
					<View3d parser={parser} active board={boardKey(source, pcbPath)} readBoard={() => source.read(pcbPath)} variants={project.variants} name={stripExt(pcbPath)} />
				</Suspense>
			</PaneContext.Provider>
		</div>
	)
}
