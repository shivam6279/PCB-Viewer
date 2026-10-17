// The 3D board view's renderer, camera and mouse handling (three.js, perspective or orthographic). It opens looking
// straight down on the top side, fitted to the board; left-drag turns the
// board like a trackball (the point under the drag follows the mouse); right- or middle-drag pans;
// the wheel zooms towards the cursor. A click picks what is under it: a part (its body, or one of its
// pads), a via, or a track (looked up in the board's 2D index at the point hit). Renders on demand.
import * as THREE from "three"
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh"
import type { PcbObject, PcbScene } from "../pcb/scene"
import { buildIndex, hitsAt, hitTest, netAt, type HitOptions, type PcbIndex } from "../pcb/hit"
import type { LayerMode } from "../pcb/layer-state"
import type { MeasureMode, MeasurePoint, SnapKind, SnapTarget, Vec3 } from "../measure/measure"
import { circleAt, snapAt } from "../measure/snap"
import type { Board3d, Board3dBody } from "./board3d"
import type { BoardGeometry, GeoMesh } from "./board-geometry"
import { buildBoardLayers, buildHighlight, geometryOf, type BoardLayers } from "./board-layers"
import { bodyMesh, componentMaterials, failedBody, flatMaterial, stepMaterial, type ComponentMaterials } from "./components"
import { boardFrame, MM, type BoardFrame } from "./frame"
import { orbit, pivotOf } from "./orbit"
import { createDimmer, dimmable, srgb, type Dimmer } from "./materials"
import type { SolderMesh } from "./solder"
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
const FLIP_MS = 350 // F: the board turning over
const FACE_MS = 400 // the view cube: turning to a face

// The view cube's faces: how the camera sits looking straight at each (its right, up and back axes in
// board terms; z out of the top, y up the board as the PCB view shows it). Bottom reads mirrored, as
// the board turned over about its vertical axis.
export type ViewAxis = "x" | "y" | "z"
export type CubeFace = "top" | "bottom" | "front" | "back" | "left" | "right"
export const CUBE_FACES: Record<CubeFace, { right: [number, number, number]; up: [number, number, number]; back: [number, number, number] }> = {
	top: { right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1] },
	bottom: { right: [-1, 0, 0], up: [0, 1, 0], back: [0, 0, -1] },
	front: { right: [1, 0, 0], up: [0, 0, 1], back: [0, -1, 0] },
	back: { right: [-1, 0, 0], up: [0, 0, 1], back: [0, 1, 0] },
	right: { right: [0, 1, 0], up: [0, 0, 1], back: [1, 0, 0] },
	left: { right: [0, -1, 0], up: [0, 0, 1], back: [-1, 0, 0] },
}

export function faceQuaternion(face: CubeFace) {
	const { right, up, back } = CUBE_FACES[face]
	const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...right), new THREE.Vector3(...up), new THREE.Vector3(...back))
	return new THREE.Quaternion().setFromRotationMatrix(m)
}

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
	pick(hit: Pick, clientX: number, clientY: number): void
	changed?(): void // the camera moved
	layerWheel?(e: WheelEvent): void // Ctrl+Shift+wheel: steps the current layer (no zoom)
}

const BODY_FADE_MS = 250 // the parts' bodies fading out of view or back in
const GHOST_OPACITY = 0.12 // highlight-current mode: the other layers, see-through
const GLOW_TAU = 70 // ms: the Shift-hover net glow's fade time constant
const HIDDEN_SHADE = 0.4 // Shift-hover: copper the board would hide from this side, this much as bright
const ANCHOR_LIMIT = 400 // points a net's label chooses among (anchorsOf)

interface Glow {
	group: THREE.Group
	materials: { copper: THREE.MeshPhongMaterial; farCopper: THREE.MeshPhongMaterial; line: THREE.LineBasicMaterial; farLine: THREE.LineBasicMaterial }
	level: number
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
	private readonly solder = new THREE.Group() // solder joints (buildSolder), one mesh per part
	private solderMaterials: { dim: THREE.Material; lit: THREE.Material } | null = null
	private readonly mats: ComponentMaterials
	private readonly dimmer: Dimmer
	private readonly index: PcbIndex
	private highlight: THREE.Group | null = null
	private hiddenKinds = new Set<string>()
	// The current layer and how the others show against it (as the PCB view's layer modes).
	private layerView: { current: string; mode: LayerMode } = { current: "TOP", mode: "all" }
	private readonly ghosts = new Map<THREE.Material, THREE.Material>()
	private readonly copperOrder: string[] // copper layer keys, top to bottom
	// Shift-hover: each net's copper over everything, its edges outlined in white, easing toward 1 while
	// hovered and back to 0 after.
	// Copper the board would hide from this side (inner layers, the far face, barrels) is drawn darker.
	private readonly glows = new Map<string, Glow>()
	private glowFacing: "top" | "bottom" | null = null // the side the glows were last painted for
	private glowTarget: string | null = null
	private glowFrame = 0
	rotateSpeed = ROTATE_PER_PX
	readonly timing = { highlight: 0, frame: 0, solder: 0 } // test hook: last highlight build, frame and solder build, ms
	private view: CameraState
	private autoFit = true // still on the opening view: re-fitted when the canvas gets its real size
	private selected: Set<number> | null = null
	private notFitted = new Set<number>() // components the shown variant leaves off: no body
	private hiddenParts = new Set<number>() // components hidden by hand: no body
	private frameRequest = 0
	private pointer: { x: number; y: number } | null = null // the cursor over the view (client px): F flips about it
	private turnFrame = 0 // a turn's animation frame (F, the view cube), while it turns
	private turnEnd: (() => void) | null = null // puts the turn at its end
	private readonly renderListeners = new Set<() => void>()
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
		options: { transparent?: boolean } = {}, // no background: a still picture laid over the page
	) {
		this.frame = boardFrame(scene, data)
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: options.transparent ?? false })
		this.renderer.setPixelRatio(window.devicePixelRatio)
		this.renderer.outputColorSpace = THREE.SRGBColorSpace
		// Every board is drawn on the same flat grey, whatever the board's own 3D workspace colour.
		if (!options.transparent) this.world.background = new THREE.Color().setRGB(200 / 255, 200 / 255, 200 / 255, THREE.SRGBColorSpace)
		this.perspective = new THREE.PerspectiveCamera(FOV, 1, 1, 10000)
		this.world.add(this.perspective, this.orthographic)

		addEvenLights(this.world)
		addEvenLights(this.overlay)

		this.dimmer = createDimmer()
		this.board = buildBoardLayers(geometry.meshes, data.colors, this.dimmer)
		for (const m of this.board.meshes) m.userData.material = m.material
		this.copperOrder = data.stack.filter(l => l.kind === "copper").map(l => l.key)
		this.world.add(this.board.group, this.parts, this.solder)
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
		this.showBoard()
	}

	// The current layer and the layer mode: all as they are; highlight: the current layer solid, the rest
	// see-through; only: the current layer alone (no parts). Copper layers keep the barrels through them.
	setLayerView(current: string, mode: LayerMode) {
		this.layerView = { current, mode }
		this.showBoard()
	}

	// The layers that can be current, top to bottom: those the board has something on.
	layerKeys(): string[] {
		const present = new Set(this.board.meshes.filter(m => m.userData.role !== "dielectric" && m.userData.role !== "barrel").map(m => m.userData.layer as string))
		return ["TOPOVERLAY", ...this.data.stack.filter(l => l.kind !== "dielectric").map(l => l.key), "BOTTOMOVERLAY"].filter(k => present.has(k))
	}

	private onCurrent(mesh: THREE.Object3D) {
		const { role, layer } = mesh.userData as { role: string; layer: string }
		return role === "barrel" ? this.copperOrder.includes(this.layerView.current) : layer === this.layerView.current
	}

	private showBoard() {
		const { mode } = this.layerView
		for (const m of this.board.meshes) {
			const kind = m.userData.kind as string
			const on = mode === "all" || this.onCurrent(m)
			m.visible = (kind === "" || !this.hiddenKinds.has(kind)) && (on || mode === "highlight")
			m.material = on ? (m.userData.material as THREE.Material) : this.ghost(m.userData.material as THREE.Material)
		}
		this.fadeParts(!this.hiddenKinds.has("body") && mode !== "only")
		this.solder.visible = !this.hiddenKinds.has("solder") && mode !== "only"
		this.requestRender()
	}

	private ghost(material: THREE.Material): THREE.Material {
		let g = this.ghosts.get(material)
		if (!g) {
			g = material.clone()
			g.transparent = true
			g.opacity = material.opacity * GHOST_OPACITY
			g.depthWrite = false
			this.ghosts.set(material, g)
		}
		return g
	}

	// Shift-hover: the net to light up (its copper, buildHighlightGeometry, drawn over everything as a
	// double-click's net is, its edges outlined in white as in the PCB view), or none. The old one fades out.
	setGlow(net: string | null, meshes?: GeoMesh[]) {
		this.glowTarget = net
		if (net !== null && meshes && !this.glows.has(net)) {
			// The copper pushed back a little in depth, so its outline is drawn over its own faces.
			const copper = (shade: number) =>
				new THREE.MeshPhongMaterial({ color: srgb(this.data.colors.copper).multiplyScalar(shade), specular: 0x000000, side: THREE.DoubleSide, transparent: true, opacity: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
			const line = (color: number) => new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0 })
			const materials = { copper: copper(1), farCopper: copper(HIDDEN_SHADE), line: line(0xffffff), farLine: line(0x6e6e6e) }
			const group = new THREE.Group()
			for (const m of meshes) {
				const g = geometryOf(m)
				const mesh = new THREE.Mesh(g, materials.copper)
				mesh.renderOrder = 11
				mesh.raycast = () => {}
				mesh.userData.layer = m.role === "barrel" ? "" : m.layer
				group.add(mesh)
				if (!m.edges?.length) continue
				const lines = new THREE.BufferGeometry()
				lines.setAttribute("position", new THREE.BufferAttribute(m.edges, 3))
				const edges = new THREE.LineSegments(lines, materials.line)
				edges.renderOrder = 12
				edges.raycast = () => {}
				edges.userData.layer = m.layer
				group.add(edges)
			}
			this.overlay.add(group)
			this.glows.set(net, { group, materials, level: 0 })
			this.paintGlow(this.glows.get(net)!, this.facing())
		}
		if (this.glowFrame) return
		let last = performance.now()
		const step = (now: number) => {
			const k = 1 - Math.exp(-Math.max(0, now - last) / GLOW_TAU)
			last = now
			let moving = false
			for (const [n, g] of this.glows) {
				const to = n === this.glowTarget ? 1 : 0
				g.level += (to - g.level) * k
				if (Math.abs(to - g.level) < 0.005) g.level = to
				if (to === 0 && g.level === 0) {
					this.overlay.remove(g.group)
					this.disposeGlow(g)
					this.glows.delete(n)
					continue
				}
				for (const m of Object.values(g.materials)) m.opacity = g.level
				if (g.level !== to) moving = true
			}
			this.requestRender()
			this.glowFrame = moving ? requestAnimationFrame(step) : 0
		}
		this.glowFrame = requestAnimationFrame(step)
	}

	private disposeGlow(g: Glow) {
		for (const o of g.group.children as THREE.Mesh[]) o.geometry.dispose()
		for (const m of Object.values(g.materials)) m.dispose()
	}

	// The side of the board the camera looks at.
	facing(): "top" | "bottom" {
		return new THREE.Vector3(0, 0, 1).applyQuaternion(this.view.quaternion).z >= 0 ? "top" : "bottom"
	}

	// A glow's copper on the outer layer facing the camera at full colour, the rest darker.
	private paintGlow(g: Glow, facing: "top" | "bottom") {
		const near = facing === "top" ? "TOP" : "BOTTOM"
		for (const o of g.group.children) {
			const seen = o.userData.layer === near
			if (o instanceof THREE.LineSegments) o.material = seen ? g.materials.line : g.materials.farLine
			else (o as THREE.Mesh).material = seen ? g.materials.copper : g.materials.farCopper
		}
	}

	// Test hook: the glowing nets and their levels.
	glowLevels(): Record<string, number> {
		return Object.fromEntries([...this.glows].map(([n, g]) => [n, g.level]))
	}

	// The parts' bodies fade out of view and back in (BODY_FADE_MS), eased, rather than vanishing: every
	// body material made see-through for the fade, put back as it was once fully shown.
	private partsLevel = 1 // 0 hidden .. 1 shown
	private partsFade = 0 // its animation frame
	private fadeParts(show: boolean) {
		const target = show ? 1 : 0
		cancelAnimationFrame(this.partsFade)
		if (this.partsLevel === target) {
			this.parts.visible = show
			return
		}
		const materials = new Set<THREE.Material>()
		this.parts.traverse(o => {
			const m = (o as THREE.Mesh).material
			if (m) for (const x of Array.isArray(m) ? m : [m]) materials.add(x)
		})
		for (const m of materials) {
			m.userData.fade ??= { opacity: m.opacity, transparent: m.transparent }
			if (!m.transparent) {
				m.transparent = true
				m.needsUpdate = true
			}
		}
		const from = this.partsLevel, started = performance.now()
		this.parts.visible = true
		const step = () => {
			const t = Math.min(1, (performance.now() - started) / BODY_FADE_MS)
			const eased = t * t * (3 - 2 * t)
			this.partsLevel = from + (target - from) * eased
			for (const m of materials) m.opacity = m.userData.fade.opacity * this.partsLevel
			this.requestRender()
			if (t < 1) {
				this.partsFade = requestAnimationFrame(step)
				return
			}
			this.partsLevel = target
			this.parts.visible = show
			// Fully shown: each material as it was (opaque ones drawn opaque again).
			if (show)
				for (const m of materials) {
					const was = m.userData.fade
					m.opacity = was.opacity
					if (m.transparent !== was.transparent) {
						m.transparent = was.transparent
						m.needsUpdate = true
					}
					delete m.userData.fade
				}
		}
		this.partsFade = requestAnimationFrame(step)
	}

	// The shown variant's not-fitted parts (component indexes): their bodies are not drawn or picked.
	setNotFitted(components: Set<number>) {
		this.notFitted = components
		this.showParts()
	}

	// Parts hidden by hand (component indexes): like not-fitted ones, not drawn or picked.
	setHiddenParts(components: Set<number>) {
		this.hiddenParts = components
		this.showParts()
	}

	private partShown(component: number | null) {
		return component === null || (!this.notFitted.has(component) && !this.hiddenParts.has(component))
	}

	private showParts() {
		for (const mesh of [...this.parts.children, ...this.solder.children]) mesh.visible = this.partShown(mesh.userData.component as number | null)
		this.requestRender()
	}

	get hasSolder() {
		return this.solderMaterials !== null
	}

	// The solder joints (buildSolder): shown with their part, dimmed and lit with it.
	setSolder(joints: SolderMesh[]) {
		for (const m of this.solder.children as THREE.Mesh[]) m.geometry.dispose()
		this.solder.clear()
		const make = () => new THREE.MeshPhongMaterial({ color: new THREE.Color().setRGB(0.78, 0.78, 0.8, THREE.SRGBColorSpace), specular: 0x555555, shininess: 60, side: THREE.DoubleSide })
		this.solderMaterials ??= { dim: dimmable(make(), this.dimmer), lit: make() }
		for (const j of joints) {
			const g = new THREE.BufferGeometry()
			g.setAttribute("position", new THREE.BufferAttribute(j.positions, 3))
			g.setIndex(new THREE.BufferAttribute(j.index, 1))
			g.computeVertexNormals()
			const mesh = new THREE.Mesh(g, this.solderMaterials.dim)
			mesh.userData = { component: j.component, solder: true }
			mesh.visible = this.partShown(j.component)
			mesh.raycast = () => {}
			this.solder.add(mesh)
		}
		this.paintSolder()
		this.requestRender()
	}

	private paintSolder() {
		if (!this.solderMaterials) return
		for (const mesh of this.solder.children as THREE.Mesh[]) {
			const lit = this.selected !== null && this.selected.has(mesh.userData.component as number)
			mesh.material = lit ? this.solderMaterials.lit : this.solderMaterials.dim
		}
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
		mesh.visible = this.partShown(b.component)
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
		this.paintSolder()
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
		this.stopTurn()
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

	// F: the board turns over, top and bottom swapped: half a turn about an axis in the board's plane
	// through the board centre, the screen's vertical laid flat on the board. From above that reads as a
	// left-right turn; from the side (where the vertical is the board's normal, and the axis tends to
	// the line of sight laid flat) the board turns over in place, its parts now hanging below. The
	// camera keeps its place relative to the centre in its own frame, so the turn only changes the
	// orientation; a point off the centre ends up mirrored across it.
	flip() {
		const from = this.getView()
		const flat = (v: THREE.Vector3) => v.applyQuaternion(from.quaternion).setZ(0)
		let axis = flat(new THREE.Vector3(0, 1, 0))
		if (axis.lengthSq() < 1e-6) axis = flat(new THREE.Vector3(0, 0, 1))
		axis.normalize()
		// About the board point under the cursor, on the board's mid-plane: that spot's other face comes
		// up where it was (the middle of the screen when the cursor is off the view).
		const pivot = this.flipPivot()
		const board = this.orbitBoard()
		const ortho = this.projection === "orthographic"
		this.animate(FLIP_MS, e => {
			const next = orbit(from, board, pivot, new THREE.Quaternion().setFromAxisAngle(axis, Math.PI * e))
			if (ortho) next.distance = from.distance
			this.view = next
		})
	}

	private flipPivot(): THREE.Vector3 {
		if (!this.pointer) return this.rotationPivot()
		const ray = this.rayAt(this.pointer.x, this.pointer.y).ray
		const mid = new THREE.Plane(new THREE.Vector3(0, 0, 1), this.frame.thickness / 2) // z = -thickness / 2
		return ray.intersectPlane(mid, new THREE.Vector3()) ?? this.rotationPivot()
	}

	// The view cube: turn to look straight at a face, the shortest way, about the same pivot as a mouse
	// turn (the middle of the screen, on the board), so the point in the middle stays there.
	showFace(face: CubeFace) {
		this.stopTurn(true)
		const from = this.getView()
		const r = faceQuaternion(face).multiply(from.quaternion.clone().invert())
		if (Math.abs(r.w) > 1 - 1e-9) return // already looking at it
		const pivot = this.rotationPivot()
		const board = this.orbitBoard()
		const ortho = this.projection === "orthographic"
		this.animate(FACE_MS, e => {
			const next = orbit(from, board, pivot, new THREE.Quaternion().slerp(r, e))
			// Orthographic: the distance is the zoom; keep it.
			if (ortho) next.distance = from.distance
			this.view = next
		})
	}

	// Turns about one of the view's own axes (x right, y up, z towards the viewer) through the mouse-turn
	// pivot: the view cube's arrows. turnAbout is immediate (an arrow dragged; pass the pivot taken when the
	// drag started), stepTurn eases a whole step (an arrow clicked).
	turnAbout(axis: ViewAxis, angle: number, pivot = this.rotationPivot()) {
		this.stopTurn()
		this.view = this.turned(this.view, axis, angle, pivot)
		this.changed()
	}

	stepTurn(axis: ViewAxis, angle: number) {
		this.stopTurn(true)
		const from = this.getView()
		const pivot = this.rotationPivot()
		this.animate(FACE_MS, e => (this.view = this.turned(from, axis, angle * e, pivot)))
	}

	private turned(view: CameraState, axis: ViewAxis, angle: number, pivot: THREE.Vector3): CameraState {
		const local = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0)
		const r = new THREE.Quaternion().setFromAxisAngle(local.applyQuaternion(view.quaternion), angle)
		const next = orbit(view, this.orbitBoard(), pivot, r)
		// Orthographic: the distance is the zoom; keep it.
		if (this.projection === "orthographic") next.distance = view.distance
		return next
	}

	// A turn eased over `ms`: `at` sets the view for an eased share 0..1. A mouse press, wheel or new
	// view stops it where it is; another turn first puts this one at its end.
	private animate(ms: number, at: (eased: number) => void) {
		this.stopTurn(true)
		const start = performance.now()
		const step = () => {
			const t = Math.min((performance.now() - start) / ms, 1)
			at(t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
			this.changed()
			this.turnFrame = t < 1 ? requestAnimationFrame(step) : 0
			this.turnEnd = t < 1 ? () => at(1) : null
		}
		step()
	}

	private stopTurn(finish = false) {
		if (!this.turnFrame) return
		cancelAnimationFrame(this.turnFrame)
		this.turnFrame = 0
		if (finish) this.turnEnd?.()
		this.turnEnd = null
	}

	// Called after every frame drawn (the view cube follows the camera).
	onRender(listener: () => void) {
		this.renderListeners.add(listener)
		return () => void this.renderListeners.delete(listener)
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
			// Near/far around the board so depth precision stays good from far out and close in: from outside
			// everything, just round it (zoomed out, a loose range left copper, mask and silkscreen, microns
			// apart, fighting through each other); from inside, close in front of the camera.
			const reach = this.reach(), d = Math.abs(distance)
			camera.near = Math.max(d - reach, d / 500, 0.01)
			camera.far = d + reach
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
		if (this.glows.size > 0) {
			const facing = this.facing()
			if (facing !== this.glowFacing) for (const g of this.glows.values()) this.paintGlow(g, facing)
			this.glowFacing = facing
		}
		if (this.highlight?.parent === this.overlay || this.glows.size > 0) {
			this.renderer.autoClear = false
			this.renderer.clearDepth()
			this.renderer.render(this.overlay, this.camera)
			this.renderer.autoClear = true
		}
		this.timing.frame = performance.now() - started
		for (const listener of this.renderListeners) listener()
	}

	// --- mouse ---------------------------------------------------------------------------------

	private bindMouse() {
		const el = this.canvas
		let drag: { button: number; x: number; y: number; startX: number; startY: number; moved: boolean; pivot: THREE.Vector3 | null } | null = null
		const down = (e: PointerEvent) => {
			this.stopTurn()
			el.setPointerCapture(e.pointerId)
			drag = { button: e.button, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, pivot: e.button === 0 ? this.rotationPivot() : null }
		}
		const move = (e: PointerEvent) => {
			this.pointer = { x: e.clientX, y: e.clientY }
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
			if (click) this.events.pick(this.pick(e.clientX, e.clientY), e.clientX, e.clientY)
		}
		const wheel = (e: WheelEvent) => {
			e.preventDefault()
			if (e.ctrlKey && e.shiftKey) return this.events.layerWheel?.(e)
			this.stopTurn()
			const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
			this.zoomAt(e.clientX, e.clientY, Math.exp(px * 0.002))
		}
		const menu = (e: Event) => e.preventDefault()
		const leave = () => (this.pointer = null)
		el.addEventListener("pointerleave", leave)
		el.addEventListener("pointerdown", down)
		el.addEventListener("pointermove", move)
		el.addEventListener("pointerup", up)
		el.addEventListener("wheel", wheel, { passive: false })
		el.addEventListener("contextmenu", menu)
		this.cleanup.push(() => {
			el.removeEventListener("pointerleave", leave)
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
		this.stopTurn()
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

	// What a ray can hit: the shown board layers (not the see-through ones), and the parts if asked.
	private pickable(withParts = true): THREE.Object3D[] {
		const out: THREE.Object3D[] = this.board.meshes.filter(m => m.visible && m.material === m.userData.material)
		if (withParts && this.parts.visible && this.partsLevel > 0) out.push(...this.parts.children.filter(m => m.visible))
		return out
	}

	// The board point under a screen point and what it is on: the copper layer hit (else, with a layer
	// mode on, the current layer; else the outer copper of the side hit), and the side.
	private boardAt(clientX: number, clientY: number, withParts: boolean) {
		const ray = this.rayAt(clientX, clientY)
		const hit = ray.intersectObjects(this.pickable(withParts), false)[0]
		// Straight down an open hole the ray meets nothing: take the board face it passed.
		let point = hit?.point ?? null
		if (!point) {
			const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(this.view.quaternion).z >= 0 ? 0 : -this.frame.thickness
			point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -facing), new THREE.Vector3())
			if (!point) return null
		}
		const side: "top" | "bottom" = point.z > -this.frame.thickness / 2 ? "top" : "bottom"
		const role = hit?.object.userData.role as string | undefined
		const layer = role === "copper" ? (hit!.object.userData.layer as string) : this.layerView.mode !== "all" ? this.layerView.current : side === "top" ? "TOP" : "BOTTOM"
		return { hit, point, x: point.x / MM + this.frame.cx, y: point.y / MM + this.frame.cy, side, layer, inBarrel: !hit || role === "barrel" }
	}

	// Whether a via / through-hole pad passes through a layer (any that is not copper: it shows there).
	private spans(o: PcbObject, layer: string) {
		const k = this.copperOrder.indexOf(layer)
		if (k < 0 || !o.span) return true
		const a = this.copperOrder.indexOf(o.span[0]), b = this.copperOrder.indexOf(o.span[1])
		if (a < 0 || b < 0) return true
		return k >= Math.min(a, b) && k <= Math.max(a, b)
	}

	private hitOptions(at: NonNullable<ReturnType<BoardEngine["boardAt"]>>): HitOptions {
		const { side, layer, inBarrel } = at
		const shown = (o: PcbObject) => {
			if (this.hiddenKinds.has(o.kind)) return false
			if (o.span) return this.spans(o, layer)
			if (inBarrel) return false
			if (o.component !== null && this.layerView.mode === "all") return this.scene.components[o.component]?.side === side
			return o.layer === layer
		}
		return { tolerance: 1, isShown: shown, current: this.copperOrder.includes(layer) ? layer : side === "top" ? "TOP" : "BOTTOM", side }
	}

	// The net of the copper under a screen point, looking past the parts to the pads under them.
	// padsOnly: only a pad's (Shift-hover).
	netAt(clientX: number, clientY: number, padsOnly = false): string | null {
		const at = this.boardAt(clientX, clientY, false)
		if (!at) return null
		const opts = { ...this.hitOptions(at), isPartShown: () => false }
		if (!padsOnly) return netAt(this.index, at.x, at.y, opts)
		for (const h of hitsAt(this.index, at.x, at.y, opts)) {
			const o = h.kind === "object" ? this.scene.objects[h.id]! : null
			if (o?.kind === "pad") return o.net ?? null
		}
		return null
	}

	// What is under a screen point: a part's body; else, on the board, a via (or the barrel of one), a
	// pad (its part), a part's footprint, a track — on the side of the board hit.
	pick(clientX: number, clientY: number): Pick {
		const at = this.boardAt(clientX, clientY, true)
		if (!at) return null
		const component = at.hit?.object.userData.component as number | null | undefined
		if (component !== undefined) return component === null ? null : { kind: "component", index: component }
		const found = hitTest(this.index, at.x, at.y, this.hitOptions(at))
		if (!found) return null
		if (found.kind === "component") return found
		const o = this.scene.objects[found.id]!
		if (o.kind === "pad" && o.component !== null) return { kind: "component", index: o.component }
		return found
	}

	// Test hooks: where a board point (mils, on that face) shows, and what is in the scene.
	// Where a ruler point lands under a screen point (board mils; z from the top face, negative down):
	// on a part's body, its nearest model vertex within reach; on the board, the nearest thing on that
	// face to snap to (snapAt); else the surface point hit. snap null: no snapping (Ctrl held).
	measurePoint(clientX: number, clientY: number, snap: { kinds: ReadonlySet<SnapKind>; reachPx: number } | null): MeasurePoint | null {
		// What the cursor is on, parts included (an unsnapped point lands there), and the board under it
		// with the parts seen through (what snaps: a body over a pad must not hide the pad's centre).
		// Straight down an open hole nothing is hit: the board face it passes (boardAt) stands in.
		const top = this.boardAt(clientX, clientY, true)
		if (!top) return null
		const toBoard = (v: THREE.Vector3, kind: SnapKind | null, on: string | null, target: SnapTarget | null): MeasurePoint => ({ x: v.x / MM + this.frame.cx, y: v.y / MM + this.frame.cy, z: v.z / MM, snap: kind, on, target })
		const component = top.hit?.object.userData.component as number | null | undefined
		const partName = component !== undefined ? (component !== null ? (this.scene.components[component]?.designator ?? "Part") : "Part") : null
		const free = toBoard(top.point, null, partName, partName ? "body" : null)
		if (!snap || snap.kinds.size === 0) return free
		const rect = this.canvas.getBoundingClientRect()
		const screen = (v: THREE.Vector3) => {
			const p = this.toCanvas(v)
			return p ? Math.hypot(p.x + rect.left - clientX, p.y + rect.top - clientY) : Infinity
		}
		// A part under the cursor: the corners of the model triangle hit, the nearest within reach.
		let body: { point: MeasurePoint; d: number } | null = null
		const hit = top.hit
		if (hit && component !== undefined && hit.face && snap.kinds.has("vertex")) {
			const pos = (hit.object as THREE.Mesh).geometry.getAttribute("position")
			for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
				const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld)
				const d = screen(v)
				if (d <= snap.reachPx && d < (body?.d ?? Infinity)) body = { point: toBoard(v, "vertex", partName, "body"), d }
			}
		}
		// The board, through the parts: what is on the face there (that side's layers, the copper layer
		// hit, what passes through), snapped within the reach in board terms there.
		let board: { point: MeasurePoint; d: number } | null = null
		const at = this.boardAt(clientX, clientY, false)
		if (at) {
			const probe = at.point.clone().add(new THREE.Vector3(MM * 10, 0, 0))
			const a = this.toCanvas(at.point), b = this.toCanvas(probe)
			const pxPerMil = a && b ? Math.hypot(b.x - a.x, b.y - a.y) / 10 : 0
			if (pxPerMil > 0) {
				const sideOf = new Map(this.scene.layers.map(l => [l.key, l.side]))
				const shown = (o: PcbObject) => !this.hiddenKinds.has(o.kind) && (o.span !== undefined || o.layer === at.layer || sideOf.get(o.layer) === at.side)
				const s = snapAt(this.scene, this.index, at.x, at.y, { reach: snap.reachPx / pxPerMil, kinds: snap.kinds, isShown: shown, pxPerMil })
				if (s) {
					const point: MeasurePoint = { x: s.x, y: s.y, z: this.faceZ(at), snap: s.kind, on: s.on, target: s.target }
					board = { point, d: screen(this.boardToWorld(point)) }
				}
			}
		}
		// Whichever of the two is nearer the cursor on screen.
		if (body && board) return body.d <= board.d ? body.point : board.point
		return body?.point ?? board?.point ?? free
	}

	// The height a point snapped on the board takes (mils): copper's own; anything else (a hole's wall,
	// the board's edge, the mask or silkscreen over it, straight down an open hole) the outer face on
	// that side, so a hole or the outline is measured at the board's surface, not part-way through.
	private faceZ(at: NonNullable<ReturnType<BoardEngine["boardAt"]>>): number {
		if (at.hit?.object.userData.role === "copper") return at.point.z / MM
		return at.side === "top" ? 0 : -this.frame.thickness / MM
	}

	// The circle a Radius / Diameter measurement takes under a screen point, on the board face there
	// (looking past the parts): its centre, and the rim point toward the cursor.
	measureCircle(clientX: number, clientY: number, reachPx: number): { a: MeasurePoint; b: MeasurePoint } | null {
		const at = this.boardAt(clientX, clientY, false)
		if (!at) return null
		const probe = at.point.clone().add(new THREE.Vector3(MM * 10, 0, 0))
		const p = this.toCanvas(at.point), q = this.toCanvas(probe)
		const pxPerMil = p && q ? Math.hypot(q.x - p.x, q.y - p.y) / 10 : 0
		if (!(pxPerMil > 0)) return null
		const sideOf = new Map(this.scene.layers.map(l => [l.key, l.side]))
		const shown = (o: PcbObject) => !this.hiddenKinds.has(o.kind) && (o.span !== undefined || o.layer === at.layer || sideOf.get(o.layer) === at.side)
		const c = circleAt(this.scene, this.index, at.x, at.y, { reach: reachPx / pxPerMil, isShown: shown })
		if (!c) return null
		const z = this.faceZ(at)
		const d = Math.hypot(at.x - c.x, at.y - c.y)
		const [ux, uy] = d > 1e-6 ? [(at.x - c.x) / d, (at.y - c.y) / d] : [1, 0]
		return { a: { x: c.x, y: c.y, z, snap: "center", on: c.on, target: null }, b: { x: c.x + ux * c.r, y: c.y + uy * c.r, z, snap: "edge", on: c.on, target: null } }
	}

	// Where a dimension line being placed goes under a screen point (board mils): on the plane through
	// the measurement facing the camera most (a distance), or parallel to the board through its first
	// point (an X or Y span, a circle).
	measurePlace(clientX: number, clientY: number, m: { mode: MeasureMode; a: Vec3; b: Vec3 }): Vec3 | null {
		const ray = this.rayAt(clientX, clientY).ray
		const a = this.boardToWorld(m.a), b = this.boardToWorld(m.b)
		let normal = new THREE.Vector3(0, 0, 1)
		if (m.mode === "distance") {
			const u = b.clone().sub(a)
			if (u.lengthSq() > 1e-12) {
				u.normalize()
				const view = this.camera.getWorldDirection(new THREE.Vector3())
				const n = view.sub(u.multiplyScalar(view.dot(u)))
				if (n.lengthSq() > 1e-6) normal = n.normalize()
			}
		}
		const hit = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, a), new THREE.Vector3())
		return hit && { x: hit.x / MM + this.frame.cx, y: hit.y / MM + this.frame.cy, z: hit.z / MM }
	}

	// Board points (mils) to the canvas, scaled (CSS px x scale), for drawing over the board: a point,
	// none behind the camera; a segment, cut at the near plane where it runs past the camera (zoomed right
	// in, a measurement's ends can be behind it while its middle is in view).
	canvasProjector(scale: number): {
		point(p: Vec3): { x: number; y: number } | null
		segment(p: Vec3, q: Vec3): [{ x: number; y: number }, { x: number; y: number }] | null
		scaleAt(p: Vec3): number
	} {
		this.applyView()
		const camera = this.camera
		const view = camera.matrixWorldInverse, projection = camera.projectionMatrix
		const w = this.canvas.clientWidth * scale, h = this.canvas.clientHeight * scale
		const front = -camera.near * 1.001 // view space: in front of the camera is z below this
		const toView = (p: Vec3) => this.boardToWorld(p).applyMatrix4(view)
		const toPx = (v: THREE.Vector3) => {
			const c = v.clone().applyMatrix4(projection)
			return { x: ((c.x + 1) / 2) * w, y: ((1 - c.y) / 2) * h }
		}
		return {
			point: p => {
				const v = toView(p)
				return v.z <= front ? toPx(v) : null
			},
			segment: (p, q) => {
				let a = toView(p), b = toView(q)
				const inA = a.z <= front, inB = b.z <= front
				if (!inA && !inB) return null
				if (!inA || !inB) {
					const cut = a.clone().lerp(b, (front - a.z) / (b.z - a.z))
					if (!inA) a = cut
					else b = cut
				}
				return [toPx(a), toPx(b)]
			},
			// A mil along the camera's own x, at that depth.
			scaleAt: p => {
				const v = toView(p)
				if (v.z > front) return 0
				const q = v.clone().add(new THREE.Vector3(MM, 0, 0))
				const a = toPx(v), b = toPx(q)
				return Math.hypot(b.x - a.x, b.y - a.y)
			},
		}
	}

	// A board point (mils; z from the top face) in world space.
	boardToWorld(p: { x: number; y: number; z: number }): THREE.Vector3 {
		return new THREE.Vector3((p.x - this.frame.cx) * MM, (p.y - this.frame.cy) * MM, p.z * MM)
	}

	// The point on the board under a screen point (looking past the parts), in world space: where a
	// net's name is pinned.
	boardPoint(clientX: number, clientY: number): THREE.Vector3 | null {
		return this.boardAt(clientX, clientY, false)?.point.clone() ?? null
	}

	// Points on some objects' copper (world space), for a net's label to sit by: each pad's and via's
	// centre, each track's middle (else the middle of whatever the objects are), with the side it is
	// seen from (a via or through-hole pad from both).
	anchorsOf(ids: Iterable<number>): { point: THREE.Vector3; side: "top" | "bottom" | "both" | "inner" }[] {
		const objects = [...ids].map(i => this.scene.objects[i]).filter((o): o is PcbObject => o !== undefined)
		const small = objects.filter(o => o.kind === "pad" || o.kind === "via" || o.kind === "track")
		const out: { point: THREE.Vector3; side: "top" | "bottom" | "both" | "inner" }[] = []
		const thickness = this.frame.thickness
		for (const o of small.length ? small : objects) {
			const [x, y] = o.at ?? [(o.bbox[0] + o.bbox[2]) / 2, (o.bbox[1] + o.bbox[3]) / 2]
			const at = (z: number) => new THREE.Vector3((x - this.frame.cx) * MM, (y - this.frame.cy) * MM, z)
			if (o.span) out.push({ point: at(0), side: "both" }, { point: at(-thickness), side: "both" })
			else if (o.layer === "TOP") out.push({ point: at(0), side: "top" })
			else if (o.layer === "BOTTOM") out.push({ point: at(-thickness), side: "bottom" })
			else {
				const layer = this.data.stack.find(l => l.key === o.layer)
				out.push({ point: at(layer ? -layer.top * MM : -thickness / 2), side: "inner" })
			}
		}
		// A label looks among a few hundred at most: an even sample of a big net.
		const step = Math.ceil(out.length / ANCHOR_LIMIT)
		return step > 1 ? out.filter((_, i) => i % step === 0) : out
	}

	// Where a world point shows on the canvas (CSS px from its top left), or null behind the camera.
	toCanvas(v: THREE.Vector3): { x: number; y: number } | null {
		this.applyView()
		const p = v.clone().project(this.camera)
		if (p.z < -1 || p.z > 1) return null
		return { x: ((p.x + 1) / 2) * this.canvas.clientWidth, y: ((1 - p.y) / 2) * this.canvas.clientHeight }
	}

	toClient(x: number, y: number, side: "top" | "bottom" = "top", z = 0) {
		this.applyView()
		const p = new THREE.Vector3((x - this.frame.cx) * MM, (y - this.frame.cy) * MM, side === "top" ? z : -this.frame.thickness - z).project(this.camera)
		const rect = this.canvas.getBoundingClientRect()
		return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
	}

	stats() {
		const meshes = this.parts.children as THREE.Mesh[]
		return { bodies: meshes.length, shown: meshes.filter(m => m.visible).length, failed: meshes.filter(m => m.userData.failed).length, boardMeshes: this.board.meshes.length }
	}

	dispose() {
		this.stopTurn()
		this.disposed = true
		cancelAnimationFrame(this.frameRequest)
		this.pendingIdle?.()
		for (const c of this.cleanup) c()
		this.setHighlight(null, false)
		cancelAnimationFrame(this.glowFrame)
		for (const g of this.glows.values()) this.disposeGlow(g)
		for (const g of this.ghosts.values()) g.dispose()
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
