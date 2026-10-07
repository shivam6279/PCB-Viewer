// The 3D board view's renderer, camera and mouse handling (three.js, perspective or orthographic). It opens looking
// straight down on the top side, fitted to the board; left-drag turns the
// board like a trackball (the point under the drag follows the mouse); right- or middle-drag pans;
// the wheel zooms towards the cursor. A click picks what is under it: a part (its body, or one of its
// pads), a via, or a track (looked up in the board's 2D index at the point hit). Renders on demand.
import * as THREE from "three"
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh"
import type { PcbObject, PcbScene } from "../pcb/scene"
import { buildIndex, hitTest, type PcbIndex } from "../pcb/hit"
import type { Board3d, Board3dBody } from "./board3d"
import type { BoardGeometry, GeoMesh } from "./board-geometry"
import { buildBoardLayers, buildHighlight, type BoardLayers } from "./board-layers"
import { bodyMesh, componentMaterials, failedBody, flatMaterial, stepMaterial, type ComponentMaterials } from "./components"
import { boardFrame, MM, type BoardFrame } from "./frame"
import { orbit, pivotOf } from "./orbit"
import { createDimmer, type Dimmer } from "./materials"
import type { StepMesh } from "./step-mesh"
import { whenIdle } from "../app/idle"

// Ray tests (zoom towards the cursor, clicks) through a bounding-volume tree per geometry: brute force
// over ~1.3 M board triangles cost ~85 ms per wheel step.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

export const FOV = 45 // vertical, degrees
const TAN = Math.tan((FOV * Math.PI) / 360) // half the view height per mm of distance
// Radians per CSS px of drag.
const ROTATE_PER_PX = (0.4 * Math.PI) / 180
const FIT_FILL = 0.83 // the fitted board's share of the view height
const CLICK_SLOP = 4

// The camera, relative to the board's geometric centre (middle of its outline, half-way through its
// thickness), the fixed origin of every turn: its orientation, its distance from the plane through the
// centre facing it, and a pan offset in its own screen plane (mm). Nothing lives in world space, so the
// same numbers always give the same picture: pan speed (from the distance alone) and turns cannot pick
// up any history of earlier zooms or pans.
export interface CameraState {
	offset: THREE.Vector2
	quaternion: THREE.Quaternion
	distance: number
}

// Orthographic: the camera's place along its own axis does not show, so the distance is free to be
// the zoom alone: the view height is 2 · distance · tan(FOV / 2). Only the wheel changes it; panning
// moves the offset and turning the orientation (plus the offset that keeps the pivot in the middle).
export type Projection = "perspective" | "orthographic"

export type Pick ={ kind: "component"; index: number } | { kind: "object"; id: number } | null

export interface EngineEvents {
	pick(hit: Pick): void
	changed?(): void // the camera moved
}

export class BoardEngine {
	readonly renderer: THREE.WebGLRenderer
	readonly frame: BoardFrame
	private readonly perspective: THREE.PerspectiveCamera
	private readonly orthographic = new THREE.OrthographicCamera()
	private projection: Projection = "perspective"
	private readonly world = new THREE.Scene()
	// A net / object highlight is drawn in a second pass over a cleared depth buffer: always visible
	// through the mask, the board and the parts, yet sorted against itself, so its holes
	// stay holes and its barrels stay inside them.
	private readonly overlay = new THREE.Scene()
	private readonly board: BoardLayers
	private readonly parts = new THREE.Group()
	private readonly mats: ComponentMaterials
	private readonly dimmer: Dimmer
	private readonly index: PcbIndex
	private highlight: THREE.Group | null = null
	private hiddenKinds = new Set<string>()
	rotateSpeed = ROTATE_PER_PX
	readonly timing = { highlight: 0, frame: 0 } // test hook: last highlight build and frame, ms
	private view: CameraState
	private autoFit = true // still on the opening view: re-fitted when the canvas gets its real size
	private selected: Set<number> | null = null
	private notFitted = new Set<number>() // components the shown variant leaves off: no body
	private frameRequest = 0
	private active = true // the 3D tab is showing (else frames wait for idle time, see setActive)
	private pendingIdle: (() => void) | null = null
	private disposed = false
	private readonly cleanup: (() => void)[] = []

	constructor(
		readonly canvas: HTMLCanvasElement,
		readonly scene: PcbScene,
		readonly data: Board3d,
		geometry: BoardGeometry,
		private readonly events: EngineEvents,
	) {
		this.frame = boardFrame(scene, data)
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
		this.renderer.setPixelRatio(window.devicePixelRatio)
		this.renderer.outputColorSpace = THREE.SRGBColorSpace
		// Every board is drawn on the same flat grey, whatever the board's own 3D workspace colour.
		this.world.background = new THREE.Color().setRGB(200 / 255, 200 / 255, 200 / 255, THREE.SRGBColorSpace)
		this.perspective = new THREE.PerspectiveCamera(FOV, 1, 1, 10000)
		this.world.add(this.perspective, this.orthographic)

		addEvenLights(this.world)
		addEvenLights(this.overlay)

		this.dimmer = createDimmer()
		this.board = buildBoardLayers(geometry.meshes, data.colors, this.dimmer)
		this.world.add(this.board.group, this.parts)
		this.mats = componentMaterials(this.dimmer)
		this.index = buildIndex(scene)
		for (const m of this.board.meshes) if (!m.geometry.boundsTree) m.geometry.computeBoundsTree() // normally built in the worker
		for (const b of data.bodies) if (!b.model) this.addBody(b, null)

		this.view = this.fitView(scene.bounds, "top")
		this.bindMouse()
		this.resize()
	}

	// --- content -------------------------------------------------------------------------------

	// A selection's copper (buildHighlightGeometry), or none.
	setHighlight(meshes: GeoMesh[] | null, overAll: boolean) {
		if (this.highlight) {
			this.highlight.parent?.remove(this.highlight)
			for (const m of this.highlight.children as THREE.Mesh[]) m.geometry.dispose()
			;((this.highlight.children[0] as THREE.Mesh | undefined)?.material as THREE.Material | undefined)?.dispose()
			this.highlight = null
		}
		if (meshes?.length) {
			this.highlight = buildHighlight(meshes, this.data.colors, overAll)
			;(overAll ? this.overlay : this.world).add(this.highlight)
		}
		this.requestRender()
	}

	// Object types switched off in the Objects panel (copper, silkscreen, barrels; "body" = parts).
	setHiddenKinds(hidden: Set<string>) {
		this.hiddenKinds = hidden
		for (const m of this.board.meshes) {
			const kind = m.userData.kind as string
			m.visible = kind === "" || !hidden.has(kind)
		}
		this.parts.visible = !hidden.has("body")
		this.requestRender()
	}

	// The shown variant's not-fitted parts (component indexes): their bodies are not drawn or picked.
	setNotFitted(components: Set<number>) {
		this.notFitted = components
		for (const mesh of this.parts.children) mesh.visible = !components.has(mesh.userData.component as number)
		this.requestRender()
	}

	// A model has arrived (or failed: null): place every body that uses it.
	setModel(key: string, mesh: StepMesh | null) {
		for (const b of this.data.bodies) if (b.model === key) this.addBody(b, mesh, mesh === null)
		this.requestRender()
	}

	private addBody(b: Board3dBody, step: StepMesh | null, failed = false) {
		const mesh = failed ? failedBody(b, this.frame, this.mats) : bodyMesh(b, this.frame, this.mats, step)
		if (!mesh) return
		mesh.userData = { component: b.component, body: b, failed }
		mesh.visible = b.component === null || !this.notFitted.has(b.component)
		if (!mesh.geometry.boundsTree) mesh.geometry.computeBoundsTree() // STEP geometries are shared: once each
		this.parts.add(mesh)
		this.paint(mesh)
	}

	// Compiles every shader and uploads every buffer now, so the first frame shown is complete.
	warmUp() {
		this.applyView()
		this.renderer.compile(this.world, this.camera)
		this.render()
	}

	// With a selection, everything but the selected parts goes grey and darker (null: no selection).
	setSelected(components: Set<number> | null) {
		this.selected = components
		this.dimmer.uniform.value = components === null ? 0 : 1
		for (const mesh of this.parts.children as THREE.Mesh[]) this.paint(mesh)
		this.requestRender()
	}

	private paint(mesh: THREE.Mesh) {
		const component = mesh.userData.component as number | null
		const body = mesh.userData.body as Board3dBody
		const lit = this.selected !== null && component !== null && this.selected.has(component)
		if (body.model !== null && !mesh.userData.failed) mesh.material = stepMaterial(this.mats, body.opacity, lit)
		else {
			const failed = mesh.userData.failed as boolean
			mesh.material = flatMaterial(this.mats, failed ? [0.5, 0.5, 0.5] : body.color, failed ? 1 : body.opacity, lit)
		}
	}

	// --- camera --------------------------------------------------------------------------------

	// Looking straight at one side, the given board box (mils) filling the view.
	fitView(box: [number, number, number, number], side: "top" | "bottom"): CameraState {
		const f = this.frame
		const [x0, y0, x1, y1] = box
		const w = Math.max((x1 - x0) * MM, 1), h = Math.max((y1 - y0) * MM, 1)
		const aspect = this.aspect()
		const half = Math.max(h / 2, w / 2 / aspect) / FIT_FILL
		const distance = half / TAN
		const quaternion = sideQuaternion(side)
		// The board face sits half its thickness in front of the centre plane.
		const centre = new THREE.Vector3(((x0 + x1) / 2 - f.cx) * MM, ((y0 + y1) / 2 - f.cy) * MM, -f.thickness / 2)
		return { quaternion, distance: distance + f.thickness / 2, offset: this.offsetOf(centre, quaternion) }
	}

	private get centre() {
		return new THREE.Vector3(0, 0, -this.frame.thickness / 2)
	}

	// A world point's place in a camera orientation's screen plane, relative to the board centre.
	private offsetOf(point: THREE.Vector3, quaternion: THREE.Quaternion) {
		const d = point.clone().sub(this.centre)
		return new THREE.Vector2(d.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion)), d.dot(new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion)))
	}

	// The world point at the middle of the screen, on the centre plane.
	private screenCentre() {
		const { quaternion: q, offset } = this.view
		return this.centre.add(new THREE.Vector3(offset.x, offset.y, 0).applyQuaternion(q))
	}

	setView(view: CameraState) {
		this.autoFit = false
		this.view = { offset: view.offset.clone(), quaternion: view.quaternion.clone(), distance: view.distance }
		this.requestRender()
	}

	getView(): CameraState {
		return { offset: this.view.offset.clone(), quaternion: this.view.quaternion.clone(), distance: this.view.distance }
	}

	// The camera drawing the view (test hook too).
	get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
		return this.projection === "perspective" ? this.perspective : this.orthographic
	}

	// Switching keeps the picture: the board point in the middle of the screen keeps its size. Only
	// the camera's place along its own axis changes, which orthographic does not show.
	setProjection(projection: Projection) {
		if (projection === this.projection) return
		const depth = this.pivotDepth()
		if (projection === "orthographic") this.view.distance = Math.max(depth, 0.3)
		else this.view.distance += Math.abs(this.view.distance) - depth
		this.projection = projection
		this.requestRender()
	}

	// Top / Bottom: look straight at that side, keeping the zoom and the point in the middle (in
	// perspective the bottom then shows slightly larger: it is a board thickness nearer).
	showSide(side: "top" | "bottom") {
		const quaternion = sideQuaternion(side)
		this.setView({ quaternion, distance: this.view.distance, offset: this.offsetOf(this.screenCentre(), quaternion) })
	}

	private aspect() {
		const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1
		return w / h
	}

	resize() {
		const w = this.canvas.clientWidth, h = this.canvas.clientHeight
		if (w === 0 || h === 0) return
		this.renderer.setSize(w, h, false)
		this.perspective.aspect = w / h
		if (this.autoFit) this.view = this.fitView(this.scene.bounds, "top")
		this.requestRender()
	}

	private applyView() {
		const { offset, quaternion, distance } = this.view
		if (this.projection === "perspective") {
			const camera = this.perspective
			camera.quaternion.copy(quaternion)
			camera.position.copy(new THREE.Vector3(offset.x, offset.y, distance).applyQuaternion(quaternion).add(this.centre))
			// Near/far around the board so depth precision stays good from far out and close in.
			camera.near = Math.min(Math.max(Math.abs(distance) / 500, 0.01), 1)
			camera.far = Math.abs(distance) * 20 + 500
			camera.updateProjectionMatrix()
			camera.updateMatrixWorld()
			return
		}
		// The view height comes from the distance (the zoom); the camera itself stands back outside
		// everything on the board however far in the view is zoomed, so nothing is cut by the near plane.
		const camera = this.orthographic
		const half = Math.abs(distance) * TAN, aspect = this.aspect()
		const reach = this.reach()
		const back = Math.max(Math.abs(distance), reach)
		camera.left = -half * aspect
		camera.right = half * aspect
		camera.top = half
		camera.bottom = -half
		camera.quaternion.copy(quaternion)
		camera.position.copy(new THREE.Vector3(offset.x, offset.y, back).applyQuaternion(quaternion).add(this.centre))
		camera.near = Math.max(back - reach, 0.01)
		camera.far = back + reach
		camera.updateProjectionMatrix()
		camera.updateMatrixWorld()
	}

	// The camera's depth to the turning pivot (the board point in the middle of the screen).
	private pivotDepth(view = this.view) {
		const q = view.quaternion
		const camera = this.centre.add(new THREE.Vector3(view.offset.x, view.offset.y, view.distance).applyQuaternion(q))
		const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
		return pivotOf(view, this.orbitBoard(), this.projection === "orthographic").sub(camera).dot(forward)
	}

	// How far anything on the board can be from its centre (mm): the outline's half-diagonal plus room
	// for tall parts.
	private reach() {
		const [x0, y0, x1, y1] = this.scene.bounds
		return Math.hypot(x1 - x0, y1 - y0) * MM * 0.5 + 100
	}

	requestRender() {
		if (this.disposed) return
		if (!this.active) {
			// Hidden behind another tab: draw in idle time, not on the click that changed something.
			this.pendingIdle ??= whenIdle(() => {
				this.pendingIdle = null
				this.render()
			})
			return
		}
		if (this.frameRequest) return
		this.frameRequest = requestAnimationFrame(() => {
			this.frameRequest = 0
			this.render()
		})
	}

	// Whether the 3D tab is showing. Coming back with a frame still owed draws it at once.
	setActive(active: boolean) {
		if (active === this.active) return
		this.active = active
		if (active && this.pendingIdle) {
			this.pendingIdle()
			this.pendingIdle = null
			this.render()
		}
	}

	render() {
		if (this.disposed || this.canvas.clientWidth === 0) return
		const started = performance.now()
		this.applyView()
		this.renderer.render(this.world, this.camera)
		if (this.highlight?.parent === this.overlay) {
			this.renderer.autoClear = false
			this.renderer.clearDepth()
			this.renderer.render(this.overlay, this.camera)
			this.renderer.autoClear = true
		}
		this.timing.frame = performance.now() - started
	}

	// --- mouse ---------------------------------------------------------------------------------

	private bindMouse() {
		const el = this.canvas
		let drag: { button: number; x: number; y: number; startX: number; startY: number; moved: boolean; pivot: THREE.Vector3 | null } | null = null
		const down = (e: PointerEvent) => {
			el.setPointerCapture(e.pointerId)
			drag = { button: e.button, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, pivot: e.button === 0 ? this.rotationPivot() : null }
		}
		const move = (e: PointerEvent) => {
			if (!drag) return
			const dx = e.clientX - drag.x, dy = e.clientY - drag.y
			drag.x = e.clientX
			drag.y = e.clientY
			if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < CLICK_SLOP) return
			drag.moved = true
			if (drag.button === 0) this.rotate(dx, dy, drag.pivot ?? undefined)
			else this.pan(dx, dy)
		}
		const up = (e: PointerEvent) => {
			if (!drag) return
			const click = !drag.moved && drag.button === 0
			drag = null
			el.releasePointerCapture(e.pointerId)
			if (click) this.events.pick(this.pick(e.clientX, e.clientY))
		}
		const wheel = (e: WheelEvent) => {
			e.preventDefault()
			const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
			this.zoomAt(e.clientX, e.clientY, Math.exp(px * 0.002))
		}
		const menu = (e: Event) => e.preventDefault()
		el.addEventListener("pointerdown", down)
		el.addEventListener("pointermove", move)
		el.addEventListener("pointerup", up)
		el.addEventListener("wheel", wheel, { passive: false })
		el.addEventListener("contextmenu", menu)
		this.cleanup.push(() => {
			el.removeEventListener("pointerdown", down)
			el.removeEventListener("pointermove", move)
			el.removeEventListener("pointerup", up)
			el.removeEventListener("wheel", wheel)
			el.removeEventListener("contextmenu", menu)
		})
	}

	// Where a turn pivots: the middle of the screen, on the board's mid-plane (see orbit.ts). Taken once
	// when a drag starts, so the pivot doesn't drift while turning.
	rotationPivot(): THREE.Vector3 {
		return pivotOf(this.view, this.orbitBoard(), this.projection === "orthographic")
	}

	// Trackball: the board turns about the view's own axes through the pivot, which stays in the middle
	// of the screen, wherever the view has been panned or zoomed to.
	rotate(dx: number, dy: number, pivot = this.rotationPivot()) {
		const q = this.view.quaternion
		const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
		const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
		const r = new THREE.Quaternion()
			.setFromAxisAngle(up, -dx * this.rotateSpeed)
			.multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * this.rotateSpeed))
		const next = orbit(this.view, this.orbitBoard(), pivot, r)
		// Orthographic: the turn moves the camera along its axis too, which would be a zoom here.
		if (this.projection === "orthographic") next.distance = this.view.distance
		this.view = next
		this.changed()
	}

	private orbitBoard() {
		const [x0, y0, x1, y1] = this.scene.bounds
		return { centre: this.centre, halfX: ((x1 - x0) / 2) * MM, halfY: ((y1 - y0) / 2) * MM }
	}

	// Panning slides the offset; its speed comes from the distance alone (the current zoom).
	pan(dx: number, dy: number) {
		const perPx = (2 * Math.abs(this.view.distance) * TAN) / (this.canvas.clientHeight || 1)
		this.view.offset.x -= dx * perPx
		this.view.offset.y += dy * perPx
		this.changed()
	}

	// Zoom towards the surface under the cursor (a part, else the board, else the centre plane): the
	// camera moves along the cursor's ray, so that point stays put, and stops short of it.
	// Orthographic: the view height scales about the point under the cursor, which also stays put.
	zoomAt(clientX: number, clientY: number, factor: number) {
		const rect = this.canvas.getBoundingClientRect()
		// The cursor ray's slope in screen terms: a point at depth t lies at offset + slope * t.
		const sx = (((clientX - rect.left) / rect.width) * 2 - 1) * TAN * this.aspect()
		const sy = (1 - ((clientY - rect.top) / rect.height) * 2) * TAN
		if (this.projection === "orthographic") {
			// The view height scales with the distance; the cursor's point sits at offset + slope ·
			// distance, so shrinking the distance by `advance` moves the offset by slope · advance.
			const d0 = Math.abs(this.view.distance)
			const d1 = THREE.MathUtils.clamp(d0 * factor, 0.3, Math.max(d0, 5000))
			if (d1 === d0) return
			this.view.distance = d1
			this.view.offset.x += sx * (d0 - d1)
			this.view.offset.y += sy * (d0 - d1)
			return this.changed()
		}
		const ray = this.rayAt(clientX, clientY)
		const forward = this.camera.getWorldDirection(new THREE.Vector3())
		const hit = ray.intersectObjects(this.pickable(), false)[0]?.point
		const depth = hit ? hit.clone().sub(this.camera.position).dot(forward) : this.view.distance
		if (!(depth > 0)) return
		// Advance (or back off) along the ray by a share of the way to that point.
		let advance = (1 - factor) * depth
		advance = Math.min(advance, depth - 0.3) // stop 0.3 mm short of the surface
		advance = Math.max(advance, this.view.distance - 5000)
		this.view.distance -= advance
		this.view.offset.x += sx * advance
		this.view.offset.y += sy * advance
		this.changed()
	}

	private changed() {
		this.autoFit = false
		this.requestRender()
		this.events.changed?.()
	}

	private rayAt(clientX: number, clientY: number) {
		const rect = this.canvas.getBoundingClientRect()
		const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
		this.applyView()
		const ray = new THREE.Raycaster()
		ray.setFromCamera(ndc, this.camera)
		ray.firstHitOnly = true
		return ray
	}

	private pickable(): THREE.Object3D[] {
		const out: THREE.Object3D[] = this.board.meshes.filter(m => m.visible)
		if (this.parts.visible) out.push(...this.parts.children.filter(m => m.visible))
		return out
	}

	// What is under a screen point: a part's body; else, on the board, a via (or the barrel of one), a
	// pad (its part), a part's footprint, a track — on the side of the board hit.
	pick(clientX: number, clientY: number): Pick {
		const ray = this.rayAt(clientX, clientY)
		const hit = ray.intersectObjects(this.pickable(), false)[0]
		const component = hit?.object.userData.component as number | null | undefined
		if (component !== undefined) return component === null ? null : { kind: "component", index: component }
		// Straight down an open hole the ray meets nothing: take the board face it passed.
		let point = hit?.point ?? null
		if (!point) {
			const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.view.quaternion).z >= 0 ? 0 : -this.frame.thickness
			point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -facing), new THREE.Vector3())
			if (!point) return null
		}
		const x = point.x / MM + this.frame.cx, y = point.y / MM + this.frame.cy
		const side: "top" | "bottom" = point.z > -this.frame.thickness / 2 ? "top" : "bottom"
		const outer = side === "top" ? "TOP" : "BOTTOM"
		const inBarrel = !hit || hit.object.userData.role === "barrel"
		const shown = (o: PcbObject) => {
			if (this.hiddenKinds.has(o.kind)) return false
			if (o.span) return true
			if (inBarrel) return false
			if (o.component !== null) return this.scene.components[o.component]?.side === side
			return o.layer === outer
		}
		const found = hitTest(this.index, x, y, { tolerance: 1, isShown: shown, current: outer, side })
		if (!found) return null
		if (found.kind === "component") return found
		const o = this.scene.objects[found.id]!
		if (o.kind === "pad" && o.component !== null) return { kind: "component", index: o.component }
		return found
	}

	// Test hooks: where a board point (mils, on that face) shows, and what is in the scene.
	toClient(x: number, y: number, side: "top" | "bottom" = "top", z = 0) {
		this.applyView()
		const p = new THREE.Vector3((x - this.frame.cx) * MM, (y - this.frame.cy) * MM, side === "top" ? z : -this.frame.thickness - z).project(this.camera)
		const rect = this.canvas.getBoundingClientRect()
		return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
	}

	stats() {
		const meshes = this.parts.children as THREE.Mesh[]
		return { bodies: meshes.length, failed: meshes.filter(m => m.userData.failed).length, boardMeshes: this.board.meshes.length }
	}

	dispose() {
		this.disposed = true
		cancelAnimationFrame(this.frameRequest)
		this.pendingIdle?.()
		for (const c of this.cleanup) c()
		this.setHighlight(null, false)
		this.world.traverse(o => {
			const m = o as THREE.Mesh
			if (m.geometry) {
				m.geometry.disposeBoundsTree?.()
				m.geometry.dispose()
			}
		})
		for (const m of this.board.materials) m.dispose()
		this.renderer.dispose()
	}
}

function sideQuaternion(side: "top" | "bottom") {
	// Bottom: turned over about the board's vertical axis, so it reads mirrored.
	return side === "top" ? new THREE.Quaternion() : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
}

// The smallest component on that side whose footprint box contains the point (board mils).
export function componentAtPoint(scene: PcbScene, x: number, y: number, side: "top" | "bottom"): number | null {
	let best: number | null = null
	let bestArea = Infinity
	scene.components.forEach((c, i) => {
		if (c.side !== side) return
		const [x0, y0, x1, y1] = c.outline
		if (x < x0 || x > x1 || y < y0 || y > y1) return
		const area = (x1 - x0) * (y1 - y0)
		if (area < bestArea) {
			bestArea = area
			best = i
		}
	})
	return best
}

// Even lighting fixed to the board, not the camera (a headlight with a sheen washes the board out
// face-on). Top and bottom faces get exactly their own colour from any
// viewing angle (three.js lights divide by pi: ambient + one face light = pi); sides get less, and
// differ by direction, so a part's edges still read. Materials carry no specular: no bright spots.
function addEvenLights(scene: THREE.Scene): void {
	const face = (x: number, y: number, z: number, intensity: number) => {
		const l = new THREE.DirectionalLight(0xffffff, intensity * Math.PI)
		l.position.set(x, y, z)
		return l
	}
	scene.add(
		new THREE.AmbientLight(0xffffff, 0.6 * Math.PI),
		face(0, 0, 1, 0.4),
		face(0, 0, -1, 0.4),
		face(1, 0.6, 0, 0.22),
		face(-0.6, -1, 0, 0.12),
	)
}
