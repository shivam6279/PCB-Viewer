// The home screen's thumbnail of a project's board, drawn here when the deploy has published none (see
// src/app/stored-preview.ts; the deploy itself draws through renderForStore). Drawing: the commit loaded
// the way the viewer loads it (the same parse, board geometry and part models), drawn once by the 3D
// view's engine on a canvas kept off screen, straight down on the top (orthographic: a plan, no
// perspective), cropped to what was drawn on a see-through background. Its facts (size, layers, parts)
// come from the same load. Kept per commit for the session.
import { buildData } from "../app/load-project-data"
import type { BoardPreview, StoredPreview } from "../app/stored-preview"
import { GitCommitSource } from "../github/commit-source"
import type { GitHub } from "../github/github"
import { loadProject } from "../model/load-project"
import { workerParser } from "../parse/worker-parser"
import type { PcbScene } from "../pcb/scene"
import { dirname } from "../source/paths"
import { boardKey } from "./board-key"
import type { Board3d } from "./board3d"
import { BoardEngine, FOV } from "./engine"
import { MM } from "./frame"
import { load3d } from "./prefetch"
import { buildSolder } from "./solder"

const DRAW_PX = 640 // CSS px of the drawing's longer side, before it is cropped
const ROOM = 1.3 // the drawing's view: the board's box and this much more, so nothing is cut off
const PAD = 0.01 // the cropped picture's margin round what was drawn, of its longer side

const made = new Map<string, Promise<BoardPreview | null>>()

// Only the picture last asked for is made: one asked for earlier, or no longer wanted (the project page
// left), stops at its next step. Otherwise clicking through projects queued a whole board load each,
// all in the workers the open project needs too.
let wanted: string | null = null
export class PreviewAbandoned extends Error {
	override name = "PreviewAbandoned"
}

export function drawBoardPreview(gh: GitHub, ref: { owner: string; repo: string }, sha: string, prjPath: string): Promise<BoardPreview | null> {
	const key = `${ref.owner}/${ref.repo}@${sha}:${prjPath}`
	wanted = key
	let p = made.get(key)
	if (!p) {
		p = render(gh, ref, sha, prjPath, () => {
			if (wanted !== key) throw new PreviewAbandoned()
		})
		p.catch(() => made.delete(key))
		made.set(key, p)
	}
	return p
}

// The picture drawn for the deploy to store (the image inline, as a data URL).
export async function renderForStore(gh: GitHub, ref: { owner: string; repo: string }, sha: string, prjPath: string): Promise<StoredPreview> {
	const p = await render(gh, ref, sha, prjPath, () => {})
	if (!p) return { none: true }
	const blob = await (await fetch(p.image)).blob()
	const image = await new Promise<string>(done => {
		const r = new FileReader()
		r.onload = () => done(r.result as string)
		r.readAsDataURL(blob)
	})
	URL.revokeObjectURL(p.image)
	return { ...p, image }
}

// The page that asked for this picture is gone.
export function abandonBoardPreview(ref: { owner: string; repo: string }, sha: string, prjPath: string): void {
	if (wanted === `${ref.owner}/${ref.repo}@${sha}:${prjPath}`) wanted = null
}

async function render(gh: GitHub, ref: { owner: string; repo: string }, sha: string, prjPath: string, check: () => void): Promise<BoardPreview | null> {
	const parser = workerParser()
	const source = new GitCommitSource(gh, ref, sha, dirname(prjPath))
	const project = await loadProject(source, prjPath, parser)
	check()
	const pcb = project.documents.find(d => d.kind === "pcb" && d.exists)
	if (!pcb) return null
	const data = await buildData(source, project, parser)
	check()
	if (!data.pcb) return null
	const loaded = await load3d(parser, data, boardKey(source, pcb.path), () => source.read(pcb.path), "preview").done
	check()
	if (!loaded) return null

	const box = outlineBox(loaded.scene)
	const w = (box[2] - box[0]) * MM, h = (box[3] - box[1]) * MM
	const scale = DRAW_PX / Math.max(w, h)
	const px = { width: Math.max(Math.round(w * scale), 1), height: Math.max(Math.round(h * scale), 1) }

	// The engine sizes itself from the canvas's layout box, so the canvas is laid out, just out of sight.
	const canvas = document.createElement("canvas")
	canvas.style.cssText = `position: fixed; left: -10000px; top: 0; width: ${px.width}px; height: ${px.height}px; pointer-events: none`
	document.body.append(canvas)
	const engine = new BoardEngine(canvas, loaded.scene, loaded.board, loaded.geometry, { pick() {} }, { transparent: true })
	try {
		for (const [k, mesh] of loaded.models) engine.setModel(k, mesh)
		engine.setSolder(buildSolder(loaded.scene, loaded.board, loaded.models, engine.frame))
		engine.setActive(true)
		engine.setProjection("orthographic")
		// Orthographic, the distance is the zoom: the view is 2 · distance · tan(FOV / 2) tall. The
		// canvas has the box's aspect, so its height alone sets the fit.
		const view = engine.fitView(box, "top")
		view.distance = ((h / 2) * ROOM) / Math.tan((FOV * Math.PI) / 360)
		engine.setView(view)
		engine.warmUp()
		const image = await cropToDrawn(canvas)
		const [r, g, b] = loaded.board.colors.topMask
		return {
			image,
			backdrop: 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "dark" : "light",
			mask: `rgb(${[r, g, b].map(c => Math.round(c * 255)).join(" ")})`,
			stats: boardStats(loaded.scene, loaded.board, w, h),
		}
	} finally {
		engine.dispose()
		canvas.remove()
	}
}

// The board outline's box (mils), its arcs followed (their vertices alone can miss most of a round
// board); the scene's bounds when there is no outline.
function outlineBox(scene: PcbScene): [number, number, number, number] {
	const path = scene.outlinePath
	if (!path?.length) return scene.bounds
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
	const add = (x: number, y: number) => {
		x0 = Math.min(x0, x)
		x1 = Math.max(x1, x)
		y0 = Math.min(y0, y)
		y1 = Math.max(y1, y)
	}
	path.forEach((seg, i) => {
		add(seg.x, seg.y)
		if (!seg.arc) return
		const { cx, cy, r, ccw } = seg.arc
		const next = path[(i + 1) % path.length]!
		const a0 = Math.atan2(seg.y - cy, seg.x - cx)
		let sweep = Math.atan2(next.y - cy, next.x - cx) - a0
		if (ccw && sweep <= 0) sweep += 2 * Math.PI
		if (!ccw && sweep >= 0) sweep -= 2 * Math.PI
		for (let k = 1; k <= 64; k++) add(cx + r * Math.cos(a0 + (sweep * k) / 64), cy + r * Math.sin(a0 + (sweep * k) / 64))
	})
	return Number.isFinite(x0) && x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : scene.bounds
}

// The drawing cropped to what was drawn on it (its see-through background left out), plus a margin.
async function cropToDrawn(canvas: HTMLCanvasElement): Promise<string> {
	const { width, height } = canvas
	const read = document.createElement("canvas")
	read.width = width
	read.height = height
	const ctx = read.getContext("2d", { willReadFrequently: true })!
	ctx.drawImage(canvas, 0, 0)
	const alpha = ctx.getImageData(0, 0, width, height).data
	let x0 = width, y0 = height, x1 = -1, y1 = -1
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++)
			if (alpha[(y * width + x) * 4 + 3]! > 8) {
				if (x < x0) x0 = x
				if (x > x1) x1 = x
				if (y < y0) y0 = y
				if (y > y1) y1 = y
			}
	if (x1 < 0) return read.toDataURL("image/png")
	const pad = Math.round(Math.max(x1 - x0, y1 - y0) * PAD)
	const out = document.createElement("canvas")
	out.width = x1 - x0 + 1 + 2 * pad
	out.height = y1 - y0 + 1 + 2 * pad
	out.getContext("2d")!.drawImage(read, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1)
	const blob = await new Promise<Blob | null>(done => out.toBlob(done, "image/webp", 0.92))
	return blob ? URL.createObjectURL(blob) : out.toDataURL("image/png")
}

function boardStats(scene: PcbScene, board: Board3d, width: number, height: number): BoardPreview["stats"] {
	const nets = new Set<string>()
	let vias = 0
	for (const o of scene.objects) {
		if (o.net) nets.add(o.net)
		if (o.kind === "via") vias++
	}
	const top = scene.components.filter(c => c.side === "top").length
	return {
		width,
		height,
		thickness: board.thickness * MM,
		copperLayers: board.stack.filter(l => l.kind === "copper").length,
		components: { top, bottom: scene.components.length - top },
		nets: nets.size,
		vias,
	}
}
