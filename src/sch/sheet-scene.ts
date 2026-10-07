// DOM side of schematic interaction: finding the object under the cursor in the rendered SVG and
// painting the hover/selection overlay.
import type { Hit } from "./interaction"
import type { ViewBox } from "./viewport"

const SVG_NS = "http://www.w3.org/2000/svg"

export interface Box {
	x: number
	y: number
	w: number
	h: number
}

export interface Scene {
	svg: SVGSVGElement
	content: SVGGElement
	overlay: SVGGElement
	paper: Box
	byIndex: Map<number, SVGGElement>
	notFitted: SVGGElement // red crosses over the shown variant's not-fitted parts, under the overlay
	ownerBoxes: Map<number, Box> | null // lazily measured: owner record -> union of its parts
}

export function createScene(svg: SVGSVGElement): Scene | null {
	const content = svg.querySelector<SVGGElement>("[data-sheet-content]")
	if (!content) return null
	const clip = svg.querySelector("#altium-sheet-paper rect")
	const num = (name: string) => Number(clip?.getAttribute(name) ?? 0)
	const paper = { x: num("x"), y: num("y"), w: num("width"), h: num("height") }

	const byIndex = new Map<number, SVGGElement>()
	for (const g of content.querySelectorAll<SVGGElement>("g[data-i]")) byIndex.set(Number(g.dataset.i), g)

	// Wires and pins are hairlines; give them a few pixels of invisible stroke to click on.
	for (const g of content.querySelectorAll<SVGGElement>('g[data-k="27"], g[data-k="2"], g[data-k="218"], g[data-k="26"]'))
		for (const line of [...g.querySelectorAll("polyline, line, path")]) {
			const hit = line.cloneNode(false) as SVGElement
			hit.setAttribute("class", "hit")
			hit.removeAttribute("stroke-width")
			hit.removeAttribute("stroke-dasharray")
			g.appendChild(hit)
		}

	const notFitted = document.createElementNS(SVG_NS, "g")
	notFitted.setAttribute("class", "sch-not-fitted")
	content.appendChild(notFitted)
	const overlay = document.createElementNS(SVG_NS, "g")
	overlay.setAttribute("class", "sch-overlay")
	content.appendChild(overlay)
	return { svg, content, overlay, notFitted, paper, byIndex, ownerBoxes: null }
}

const readHit = (g: Element): Hit => {
	const o = g.getAttribute("data-o")
	return { i: Number(g.getAttribute("data-i")), k: g.getAttribute("data-k") ?? "", o: o === null ? null : Number(o) }
}

export function toSheetPoint(scene: Scene, clientX: number, clientY: number): { x: number; y: number } | null {
	const ctm = scene.svg.getScreenCTM?.()
	if (!ctm) return null
	const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
	return { x: p.x, y: p.y }
}

// The drawn object under a client point: the record element itself, else the smallest component or
// sheet symbol whose outline contains the point (clicking inside a part's body, between its lines).
export function hitTest(scene: Scene, clientX: number, clientY: number): Hit | null {
	const el = document.elementFromPoint(clientX, clientY)
	const g = el?.closest("g[data-i]")
	if (g && scene.content.contains(g) && !scene.overlay.contains(g)) return readHit(g)
	const p = toSheetPoint(scene, clientX, clientY)
	if (!p) return null
	let best: { o: number; area: number } | null = null
	for (const [o, b] of ownerBoxes(scene)) {
		if (p.x < b.x || p.x > b.x + b.w || p.y < b.y || p.y > b.y + b.h) continue
		const area = b.w * b.h
		if (!best || area < best.area) best = { o, area }
	}
	if (!best) return null
	const owner = scene.byIndex.get(best.o)
	return owner ? readHit(owner) : { i: best.o, k: "", o: best.o }
}

// Outline of each component / sheet symbol: the union of its drawn parts, excluding parameter and
// designator text, which Altium places freely and which would otherwise swallow neighbours.
export function ownerBoxes(scene: Scene): Map<number, Box> {
	if (scene.ownerBoxes) return scene.ownerBoxes
	const groups = new Map<number, SVGGElement[]>()
	for (const g of scene.content.querySelectorAll<SVGGElement>("g[data-o]")) {
		if (g.dataset.k === "41" || g.dataset.k === "34") continue
		const o = Number(g.dataset.o)
		;(groups.get(o) ?? groups.set(o, []).get(o)!).push(g)
	}
	for (const [o, g] of scene.byIndex) if (g.dataset.k === "1" || g.dataset.k === "15") (groups.get(o) ?? groups.set(o, []).get(o)!).push(g)
	scene.ownerBoxes = new Map([...groups].map(([o, gs]) => [o, unionBox(gs)]).filter((e): e is [number, Box] => e[1] !== null))
	return scene.ownerBoxes
}

export function unionBox(elements: Iterable<SVGGraphicsElement>): Box | null {
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	for (const el of elements) {
		let b: DOMRect
		try {
			b = el.getBBox()
		} catch {
			continue
		}
		if (b.width === 0 && b.height === 0 && b.x === 0 && b.y === 0) continue
		minX = Math.min(minX, b.x)
		minY = Math.min(minY, b.y)
		maxX = Math.max(maxX, b.x + b.width)
		maxY = Math.max(maxY, b.y + b.height)
	}
	return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// Everything drawn for a component or sheet symbol, including its texts.
export function ownerElements(scene: Scene, o: number): SVGGElement[] {
	const own = scene.byIndex.get(o)
	return [...(own ? [own] : []), ...scene.content.querySelectorAll<SVGGElement>(`g[data-o="${o}"]`)]
}

// Parts a variant leaves off: everything drawn for them greyed (class not-fitted), and a red cross
// corner to corner over the body (its outline without texts). Replaces the previous marking.
export function markNotFitted(scene: Scene, owners: number[]) {
	for (const g of scene.content.querySelectorAll(".not-fitted")) g.classList.remove("not-fitted")
	scene.notFitted.replaceChildren()
	for (const o of owners) {
		for (const g of ownerElements(scene, o)) g.classList.add("not-fitted")
		const b = ownerBoxes(scene).get(o)
		if (!b) continue
		for (const [x1, y1, x2, y2] of [[b.x, b.y, b.x + b.w, b.y + b.h], [b.x, b.y + b.h, b.x + b.w, b.y]]) {
			const line = document.createElementNS(SVG_NS, "line")
			line.setAttribute("x1", String(x1))
			line.setAttribute("y1", String(y1))
			line.setAttribute("x2", String(x2))
			line.setAttribute("y2", String(y2))
			line.setAttribute("data-o", String(o))
			scene.notFitted.appendChild(line)
		}
	}
}

export interface OverlayState {
	selectedNet: number[] | null // object indexes of the selected net on this sheet
	selectedOwner: number | null // selected component on this sheet
	hoverNet: number[] | null
	hoverOwner: number | null
	diff?: { indices: number[]; tone: "removed" | "added" } | null // compare: objects only in this commit
}

// Net objects framed with a lilac box rather than a halo.
const BOXED_KINDS = new Set(["25", "17", "18", "16"])

export function paintOverlay(scene: Scene, state: OverlayState) {
	const { overlay } = scene
	overlay.replaceChildren()
	const selecting = state.selectedNet !== null || state.selectedOwner !== null
	if (selecting) overlay.appendChild(rect(scene.paper, "sel-dim"))
	if (state.diff && state.diff.indices.length) {
		// Everything else fades; what differs is boxed and drawn over in the tone (red / green).
		overlay.appendChild(rect(scene.paper, "diff-dim"))
		const groups = state.diff.indices.map(i => scene.byIndex.get(i)).filter((g): g is SVGGElement => g !== undefined)
		for (const g of groups) {
			const b = unionBox([g])
			// Padded generously: a change must be findable with the whole sheet in view.
			if (b) overlay.appendChild(rect(pad(b, 8), `diff-box diff-${state.diff.tone}`))
		}
		for (const g of groups) overlay.appendChild(clone(g, `diff-ink diff-${state.diff.tone}`))
	}

	if (state.hoverOwner !== null && state.hoverOwner !== state.selectedOwner) {
		const b = ownerBoxes(scene).get(state.hoverOwner)
		if (b) overlay.appendChild(rect(pad(b, 2), "hover-box"))
	}
	if (state.hoverNet && state.hoverNet !== state.selectedNet) addNet(scene, state.hoverNet, "hover-net")
	if (state.selectedOwner !== null) {
		const b = ownerBoxes(scene).get(state.selectedOwner)
		if (b) overlay.appendChild(rect(pad(b, 3), "sel-box"))
		for (const g of ownerElements(scene, state.selectedOwner)) overlay.appendChild(clone(g, "sel-part"))
	}
	if (state.selectedNet) addNet(scene, state.selectedNet, "sel-net")
}

function addNet(scene: Scene, objects: number[], cls: string) {
	const boxes: SVGElement[] = []
	const drawn: SVGElement[] = []
	for (const i of objects) {
		const g = scene.byIndex.get(i)
		if (!g) continue
		if (BOXED_KINDS.has(g.dataset.k ?? "")) {
			const b = unionBox([g])
			if (b) boxes.push(rect(pad(b, 1.5), `${cls}-box`))
		}
		drawn.push(clone(g, cls))
	}
	scene.overlay.append(...boxes, ...drawn)
}

function clone(g: SVGGElement, cls: string): SVGElement {
	const c = g.cloneNode(true) as SVGGElement
	c.setAttribute("data-ci", g.getAttribute("data-i") ?? "") // which object this copies, for tests
	c.removeAttribute("data-i")
	c.removeAttribute("data-o")
	c.setAttribute("class", cls)
	return c
}

function rect(b: Box, cls: string): SVGRectElement {
	const r = document.createElementNS(SVG_NS, "rect")
	r.setAttribute("x", String(b.x))
	r.setAttribute("y", String(b.y))
	r.setAttribute("width", String(b.w))
	r.setAttribute("height", String(b.h))
	r.setAttribute("class", cls)
	return r
}

const pad = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d })

// A view framing some objects with room around them, never closer than a minimum width.
export function frameObjects(scene: Scene, objects: number[], minWidth: number): ViewBox | null {
	const b = unionBox(objects.map(i => scene.byIndex.get(i)).filter((g): g is SVGGElement => g !== undefined))
	if (!b) return null
	const w = Math.max(b.w * 1.6, minWidth)
	const h = Math.max(b.h * 1.6, minWidth * 0.5)
	return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h }
}
