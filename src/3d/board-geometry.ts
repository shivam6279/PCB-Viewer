// The board as real 3D geometry, built from the PCB scene (worker side, pure): every copper layer at
// its depth in the stack with the drill holes cut out of it, the dielectric between them (banded by
// layer, so the board's edge shows the stack), the solder masks with their openings, the silkscreen,
// and a plated barrel in every plated hole. Polygons are unioned and cut with Clipper2, then
// triangulated with earcut. (clipper-lib, the JS port of Clipper 6: clipper2-js returned wrong
// differences and an empty polygon tree.) Meshes are split by layer and object type, so the Objects panel can hide
// a type without a rebuild. Output: plain typed arrays in world mm (board-centred, z = 0 at the top
// surface, the board extending to -thickness).
import * as ClipperNs from "clipper-lib"
import earcut from "earcut"
import type { PcbObject, PcbScene, Prim } from "../pcb/scene"
import type { Board3d, StackLayer } from "./board3d"

export const MM = 0.0254
const SCALE = 100 // clipper units per mil
const SILK_LIFT = 0.006 // mm above the mask
const TILE_HOLES = 48 // holes per triangulation tile (see capTiled)

export type GeoRole = "copper" | "dielectric" | "mask" | "silk" | "barrel"

export interface GeoMesh {
	role: GeoRole
	layer: string // stack key (TOP, MID-LAYER3, DIELECTRIC10, TOPSOLDER, TOPOVERLAY…)
	kind: string // Objects-panel kind (track, pad, via, polygon…) or "" for the board itself
	core?: boolean // dielectric: core (else prepreg)
	// A serialised three-mesh-bvh tree for ray tests (built in the 3D worker), all its fields kept (the
	// format version matters) except the index, which is the mesh's own.
	bvh?: { roots: ArrayBuffer[]; [field: string]: unknown }
	positions: Float32Array
	normals: Float32Array
	index: Uint32Array
}

export interface BoardGeometry {
	meshes: GeoMesh[]
}

// The Objects-panel kind an object belongs to (Polygons = poured regions).
export function kindOf(obj: PcbObject): string {
	if (obj.kind === "region" && obj.pour) return "polygon"
	return obj.kind
}

// clipper-lib is CommonJS: Node hands it over as the default export, bundlers as the namespace.
const ClipperLib = ((ClipperNs as unknown as { default?: typeof ClipperNs }).default ?? ClipperNs) as typeof ClipperNs
type Path64 = ClipperNs.Path
type Paths64 = ClipperNs.Paths
type PolyTree64 = ClipperNs.PolyTree
type PolyPathBase = ClipperNs.PolyNode
const NONZERO = ClipperLib.PolyFillType.pftNonZero
const isPositive = (p: Path64) => ClipperLib.Clipper.Orientation(p)

function run(type: ClipperNs.ClipType, subject: Paths64, clip?: Paths64): Paths64 {
	const c = new ClipperLib.Clipper()
	c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true)
	if (clip?.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true)
	const out: Paths64 = []
	c.Execute(type, out, NONZERO, NONZERO)
	return out
}

function inflate(paths: Paths64, delta: number, miter: boolean): Paths64 {
	const o = new ClipperLib.ClipperOffset(4, 0.25 * SCALE)
	o.AddPaths(paths, miter ? ClipperLib.JoinType.jtMiter : ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
	const out: Paths64 = []
	o.Execute(out, delta)
	return out
}

// --- prims -> clipper paths ------------------------------------------------------------------------

// Curves are cut so no chord strays more than CURVE_TOLERANCE from the true arc (a 0.45 mm via ring:
// ~48 sides; a big pad up to 128), so holes and rings read as circles even zoomed right in.
const CURVE_TOLERANCE = 0.02 // mils
// Inner copper is only ever seen through the board's translucent edge: coarser curves there.
const INNER_TOLERANCE = 0.3
let tolerance = CURVE_TOLERANCE
function withTolerance<T>(t: number, run: () => T): T {
	const before = tolerance
	tolerance = t
	try {
		return run()
	} finally {
		tolerance = before
	}
}
const segs = (r: number, sweep = Math.PI * 2) => {
	const rr = Math.max(r, 0.5)
	const step = 2 * Math.acos(Math.max(-1, 1 - tolerance / rr)) // angle per chord
	return Math.max(8, Math.min(Math.ceil((128 * sweep) / (Math.PI * 2)), Math.ceil(sweep / step)))
}
const pt = (x: number, y: number) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })

function circlePath(x: number, y: number, r: number): Path64 {
	const n = Math.max(16, segs(r))
	const p = ([] as Path64)
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2
		p.push(pt(x + r * Math.cos(a), y + r * Math.sin(a)))
	}
	return p
}

function capsulePath(x1: number, y1: number, x2: number, y2: number, r: number): Path64 {
	const len = Math.hypot(x2 - x1, y2 - y1)
	if (len < 1e-6) return circlePath(x1, y1, r)
	const a = Math.atan2(y2 - y1, x2 - x1)
	const n = Math.max(6, Math.ceil(segs(r) / 2))
	const p = ([] as Path64)
	for (let i = 0; i <= n; i++) {
		const t = a - Math.PI / 2 + (i / n) * Math.PI
		p.push(pt(x2 + r * Math.cos(t), y2 + r * Math.sin(t)))
	}
	for (let i = 0; i <= n; i++) {
		const t = a + Math.PI / 2 + (i / n) * Math.PI
		p.push(pt(x1 + r * Math.cos(t), y1 + r * Math.sin(t)))
	}
	return p
}

function arcStrokePath(cx: number, cy: number, r: number, a0deg: number, a1deg: number, w: number): Path64 {
	const a0 = (a0deg * Math.PI) / 180, a1 = (a1deg * Math.PI) / 180
	const hw = w / 2
	const n = segs(r + hw, a1 - a0)
	const p = ([] as Path64)
	for (let i = 0; i <= n; i++) {
		const a = a0 + ((a1 - a0) * i) / n
		p.push(pt(cx + (r + hw) * Math.cos(a), cy + (r + hw) * Math.sin(a)))
	}
	const capN = Math.max(4, Math.ceil(segs(hw) / 2))
	const ex = cx + r * Math.cos(a1), ey = cy + r * Math.sin(a1)
	for (let i = 1; i < capN; i++) {
		const t = a1 + (i / capN) * Math.PI
		p.push(pt(ex + hw * Math.cos(t), ey + hw * Math.sin(t)))
	}
	const ri = Math.max(r - hw, 0)
	for (let i = n; i >= 0; i--) {
		const a = a0 + ((a1 - a0) * i) / n
		p.push(pt(cx + ri * Math.cos(a), cy + ri * Math.sin(a)))
	}
	const sx = cx + r * Math.cos(a0), sy = cy + r * Math.sin(a0)
	for (let i = 1; i < capN; i++) {
		const t = a0 + Math.PI + (i / capN) * Math.PI
		p.push(pt(sx + hw * Math.cos(t), sy + hw * Math.sin(t)))
	}
	return p
}

function ringPath(ring: number[]): Path64 {
	const p = ([] as Path64)
	for (let k = 0; k + 1 < ring.length; k += 2) p.push(pt(ring[k]!, ring[k + 1]!))
	return p
}

// A prim's filled area as paths wound for a NonZero union: outlines positive, holes negative.
export function primPaths(p: Prim, out: Paths64) {
	const add = (path: Path64, hole = false) => {
		if (path.length < 3) return
		if (isPositive(path) === hole) path.reverse()
		out.push(path)
	}
	switch (p.t) {
		case "circle":
			add(circlePath(p.x, p.y, p.r))
			break
		case "seg":
			add(capsulePath(p.x1, p.y1, p.x2, p.y2, p.w / 2))
			break
		case "arc":
			if (p.w > 0) add(arcStrokePath(p.x, p.y, p.r, p.a0, p.a1, p.w))
			break
		case "poly":
			p.rings.forEach((ring, i) => add(ringPath(ring), i > 0))
			break
		case "text":
			break // TrueType text: not drawn in 3D yet
	}
}

const union = (paths: Paths64) => run(ClipperLib.ClipType.ctUnion, paths)

function difference(subject: Paths64, clip: Paths64): PolyTree64 {
	const c = new ClipperLib.Clipper()
	c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true)
	if (clip.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true)
	const tree = new ClipperLib.PolyTree()
	c.Execute(ClipperLib.ClipType.ctDifference, tree, NONZERO, NONZERO)
	return tree
}

function treeOf(paths: Paths64): PolyTree64 {
	return difference(paths, ([] as Paths64))
}

// --- triangulation ---------------------------------------------------------------------------------

class MeshBuilder {
	positions: number[] = []
	normals: number[] = []
	index: number[] = []

	constructor(readonly cx: number, readonly cy: number) {}

	private xy(p: { X: number; Y: number }): [number, number] {
		return [(p.X / SCALE - this.cx) * MM, (p.Y / SCALE - this.cy) * MM]
	}

	// Flat faces of a polygon set at height z, facing up (+z) or down.
	cap(tree: PolyTree64, z: number, up: boolean) {
		const visit = (node: PolyPathBase) => {
			for (const child of node.Childs()) {
				if (child.IsHole()) continue
				if (child.Childs().length > TILE_HOLES) this.capTiled(child, z, up)
				else this.capPolygon(child, z, up)
				for (const hole of child.Childs()) visit(hole)
			}
		}
		visit(tree)
	}

	// earcut bridges holes in quadratic time: a board face with thousands of drills (LedFlex: 3321)
	// is cut into tiles of a few dozen holes each and triangulated tile by tile.
	private capTiled(node: PolyPathBase, z: number, up: boolean) {
		const holes = node.Childs().map(h => {
			const ring = h.Contour()
			let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity
			for (const p of ring) {
				a = Math.min(a, p.X)
				b = Math.min(b, p.Y)
				c = Math.max(c, p.X)
				d = Math.max(d, p.Y)
			}
			return { ring, box: [a, b, c, d] as const }
		})
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
		for (const p of node.Contour()) {
			x0 = Math.min(x0, p.X)
			y0 = Math.min(y0, p.Y)
			x1 = Math.max(x1, p.X)
			y1 = Math.max(y1, p.Y)
		}
		const n = Math.ceil(Math.sqrt(node.Childs().length / TILE_HOLES))
		const sx = (x1 - x0) / n, sy = (y1 - y0) / n
		for (let i = 0; i < n; i++)
			for (let j = 0; j < n; j++) {
				const ax = Math.floor(x0 + i * sx), bx = i === n - 1 ? x1 : Math.floor(x0 + (i + 1) * sx)
				const ay = Math.floor(y0 + j * sy), by = j === n - 1 ? y1 : Math.floor(y0 + (j + 1) * sy)
				const cell: Path64 = [{ X: ax, Y: ay }, { X: bx, Y: ay }, { X: bx, Y: by }, { X: ax, Y: by }]
				const c = new ClipperLib.Clipper()
				c.AddPath(node.Contour(), ClipperLib.PolyType.ptSubject, true)
				for (const h of holes) if (h.box[2] >= ax && h.box[0] <= bx && h.box[3] >= ay && h.box[1] <= by) c.AddPath(h.ring, ClipperLib.PolyType.ptSubject, true)
				c.AddPath(cell, ClipperLib.PolyType.ptClip, true)
				const tile = new ClipperLib.PolyTree()
				c.Execute(ClipperLib.ClipType.ctIntersection, tile, ClipperLib.PolyFillType.pftEvenOdd, NONZERO)
				for (const part of tile.Childs()) if (!part.IsHole()) this.capPolygon(part, z, up)
			}
	}

	private capPolygon(node: PolyPathBase, z: number, up: boolean) {
		// Triangulated on the exact integer coordinates, after dropping near-duplicate and collinear
		// points (they left hairline cracks along earcut's hole bridges).
		const flat: number[] = []
		const holes: number[] = []
		const pushRing = (ring: Path64) => {
			for (const p of ClipperLib.Clipper.CleanPolygon(ring, 1.5)) flat.push(p.X, p.Y)
		}
		pushRing(node.Contour())
		for (const h of node.Childs()) {
			const before = flat.length
			holes.push(before / 2)
			pushRing(h.Contour())
			if (flat.length - before < 6) {
				flat.length = before
				holes.pop()
			}
		}
		if (flat.length < 6) return
		const tris = earcut(flat, holes, 2)
		const base = this.positions.length / 3
		for (let i = 0; i < flat.length; i += 2) {
			const [x, y] = this.xy({ X: flat[i]!, Y: flat[i + 1]! })
			this.positions.push(x, y, z)
			this.normals.push(0, 0, up ? 1 : -1)
		}
		for (let i = 0; i < tris.length; i += 3) {
			// earcut winds as the input; make every triangle face its normal.
			const a = base + tris[i]!, b = base + tris[i + 1]!, c = base + tris[i + 2]!
			const ax = this.positions[a * 3]!, ay = this.positions[a * 3 + 1]!
			const cross = (this.positions[b * 3]! - ax) * (this.positions[c * 3 + 1]! - ay) - (this.positions[b * 3 + 1]! - ay) * (this.positions[c * 3]! - ax)
			if (cross > 0 === up) this.index.push(a, b, c)
			else this.index.push(a, c, b)
		}
	}

	// Side walls of every contour of a polygon set between z0 (top) and z1, facing out of the material
	// (or into it, for barrels seen from inside a hole: inward = true).
	walls(tree: PolyTree64, z0: number, z1: number, inward = false) {
		const visit = (node: PolyPathBase) => {
			for (const child of node.Childs()) {
				this.wallRing(child.Contour(), child.IsHole(), z0, z1, inward)
				visit(child)
			}
		}
		visit(tree)
	}

	wallRing(ring: Path64, hole: boolean, z0: number, z1: number, inward = false) {
		const n = ring.length
		if (n < 3) return
		const pts = ring.map(p => this.xy(p))
		// Material lies left of a CCW outline and right of a CW hole: outward is (dy, -dx) for both
		// when outlines run CCW and holes CW.
		const ccw = signedArea(pts) > 0
		const flip = (hole ? !ccw : ccw) ? 1 : -1
		const sign = inward ? -flip : flip
		// Smooth normals across shallow corners (round holes, arcs), sharp at real corners.
		const edgeN: [number, number][] = []
		for (let i = 0; i < n; i++) {
			const [x0, y0] = pts[i]!, [x1, y1] = pts[(i + 1) % n]!
			const dx = x1 - x0, dy = y1 - y0
			const l = Math.hypot(dx, dy) || 1
			edgeN.push([(sign * dy) / l, (-sign * dx) / l])
		}
		for (let i = 0; i < n; i++) {
			const [x0, y0] = pts[i]!, [x1, y1] = pts[(i + 1) % n]!
			const ne = edgeN[i]!
			const smooth = (j: number) => {
				const other = edgeN[(j + n) % n]!
				if (ne[0] * other[0] + ne[1] * other[1] < Math.cos((40 * Math.PI) / 180)) return ne
				const sx = ne[0] + other[0], sy = ne[1] + other[1]
				const l = Math.hypot(sx, sy) || 1
				return [sx / l, sy / l] as [number, number]
			}
			const n0 = smooth(i - 1), n1 = smooth(i + 1)
			const base = this.positions.length / 3
			this.positions.push(x0, y0, z0, x1, y1, z0, x1, y1, z1, x0, y0, z1)
			this.normals.push(n0[0], n0[1], 0, n1[0], n1[1], 0, n1[0], n1[1], 0, n0[0], n0[1], 0)
			// Front face towards the normal.
			const ex = x1 - x0, ey = y1 - y0
			const faces = ne[0] * ey - ne[1] * ex < 0 // normal on the right of the edge, seen from above
			if (faces) this.index.push(base, base + 1, base + 2, base, base + 2, base + 3)
			else this.index.push(base, base + 2, base + 1, base, base + 3, base + 2)
		}
	}

	get empty() {
		return this.index.length === 0
	}

	mesh(role: GeoRole, layer: string, kind: string, extra: Partial<GeoMesh> = {}): GeoMesh {
		return { role, layer, kind, ...extra, positions: new Float32Array(this.positions), normals: new Float32Array(this.normals), index: new Uint32Array(this.index) }
	}
}

function signedArea(pts: [number, number][]) {
	let a = 0
	for (let i = 0; i < pts.length; i++) {
		const [x0, y0] = pts[i]!, [x1, y1] = pts[(i + 1) % pts.length]!
		a += x0 * y1 - x1 * y0
	}
	return a / 2
}

// --- the board -------------------------------------------------------------------------------------

interface Drill {
	kind: string // the owner's Objects-panel kind (via, pad)
	path: Path64
	// For inner layers, whose hole edges hide behind the barrel: a coarse polygon drawn just outside
	// the hole (never inside the barrel).
	coarse: Path64
	from: number // stack index of the first copper layer it passes
	to: number
	plated: boolean
	tentTop: boolean // a tented via: the mask stays closed over it
	tentBottom: boolean
}

interface Context {
	scene: PcbScene
	board: Board3d
	cx: number
	cy: number
	copper: StackLayer[] // copper layers, top to bottom
	z: (depthMils: number) => number
}

function context(scene: PcbScene, board: Board3d): Context {
	const [x0, y0, x1, y1] = scene.bounds
	return { scene, board, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, copper: board.stack.filter(l => l.kind === "copper"), z: d => -d * MM }
}

// The copper layers an object is on: its own, or every layer of a via / through-hole pad's span.
function layersOf(ctx: Context, obj: PcbObject): string[] {
	if (!obj.span) return [obj.layer]
	const keys = ctx.copper.map(l => l.key)
	const a = keys.indexOf(obj.span[0]), b = keys.indexOf(obj.span[1])
	if (a < 0 || b < 0) return keys
	return keys.slice(Math.min(a, b), Math.max(a, b) + 1)
}

function drillsOf(ctx: Context): Drill[] {
	const keys = ctx.copper.map(l => l.key)
	const out: Drill[] = []
	for (const o of ctx.scene.objects) {
		for (const h of o.holes) {
			const paths = ([] as Paths64)
			primPaths(h, paths)
			if (!paths[0]) continue
			let from = 0, to = keys.length - 1
			if (o.kind === "via" && o.span) {
				const a = keys.indexOf(o.span[0]), b = keys.indexOf(o.span[1])
				if (a >= 0 && b >= 0) [from, to] = [Math.min(a, b), Math.max(a, b)]
			}
			let coarse = paths[0]
			if (h.t === "circle") {
				const n = 12, R = h.r / Math.cos(Math.PI / n)
				coarse = Array.from({ length: n }, (_, i) => pt(h.x + R * Math.cos((i / n) * Math.PI * 2), h.y + R * Math.sin((i / n) * Math.PI * 2)))
			}
			out.push({ kind: kindOf(o), path: paths[0], coarse, from, to, plated: o.pad?.plated !== false, tentTop: o.kind === "via" && o.mask?.top === null, tentBottom: o.kind === "via" && o.mask?.bottom === null })
		}
	}
	return out
}

function boardOutline(ctx: Context): Paths64 {
	const paths = ([] as Paths64)
	const outline = ringPath(ctx.scene.outline)
	if (!isPositive(outline)) outline.reverse()
	paths.push(outline)
	for (const c of ctx.scene.cutouts) {
		if (c.length < 6) continue
		const p = ringPath(c)
		if (isPositive(p)) p.reverse()
		paths.push(p)
	}
	return union(paths)
}

const pathsOf = (drills: Drill[]) => {
	const p = ([] as Paths64)
	for (const d of drills) p.push(d.path)
	return p
}

// Copper of a set of objects on one copper layer, minus the drills through it.
// A layer's copper: drilled (its faces) and undrilled (its edges: a drilled hole's edge is lined by the
// hole's barrel, so it needs no wall of its own; leaving them out halves the inner layers' triangles).
interface CopperTrees {
	drilled: PolyTree64
	solid: PolyTree64
}

function copperTree(ctx: Context, objects: PcbObject[], layerIndex: number, drills: Drill[]): CopperTrees | null {
	const paths = ([] as Paths64)
	for (const o of objects) for (const p of o.prims) primPaths(p, paths)
	if (paths.length === 0) return null
	const through = drills.filter(d => d.from <= layerIndex && d.to >= layerIndex)
	const merged = union(paths)
	const inner = layerIndex > 0 && layerIndex < ctx.copper.length - 1
	return { drilled: difference(merged, inner ? through.map(d => d.coarse) : pathsOf(through)), solid: treeOf(merged) }
}

// Copper as a slab of its stackup thickness. Outer layers: the outward face, and edges where they can
// be seen (pads in their mask openings; highlights). Inner layers: both faces and their edges (seen
// through the translucent board edge, and in a highlighted net).
function copperMesh(ctx: Context, trees: CopperTrees, layer: StackLayer, kind: string): GeoMesh | null {
	const tree = trees.drilled
	const m = new MeshBuilder(ctx.cx, ctx.cy)
	const z0 = ctx.z(layer.top), z1 = ctx.z(layer.bottom)
	const copper = ctx.copper
	// Edges only where they can be seen: pads in their mask openings (and highlights, kind "").
	// Tracks, vias and pours stay under the mask, where a 35 µm edge is invisible.
	const edges = kind === "pad" || kind === ""
	if (layer === copper[0]) {
		m.cap(tree, z0, true)
		if (edges) m.walls(trees.solid, z0, z1)
	} else if (layer === copper[copper.length - 1]) {
		m.cap(tree, z1, false)
		if (edges) m.walls(trees.solid, z0, z1)
	} else {
		m.cap(tree, z0, true)
		m.cap(tree, z1, false)
		m.walls(trees.solid, z0, z1)
	}
	return m.empty ? null : m.mesh("copper", layer.key, kind)
}

export function buildBoardGeometry(scene: PcbScene, board: Board3d): BoardGeometry {
	const ctx = context(scene, board)
	const meshes: GeoMesh[] = []
	const drills = drillsOf(ctx)
	const outline = boardOutline(ctx)

	// Copper, per layer and object type.
	ctx.copper.forEach((layer, li) => {
		const byKind = new Map<string, PcbObject[]>()
		for (const o of scene.objects) {
			if (!layersOf(ctx, o).includes(layer.key)) continue
			const k = kindOf(o)
			let list = byKind.get(k)
			if (!list) byKind.set(k, (list = []))
			list.push(o)
		}
		const inner = li > 0 && li < ctx.copper.length - 1
		for (const [kind, objects] of byKind) {
			const tree = withTolerance(inner ? INNER_TOLERANCE : CURVE_TOLERANCE, () => copperTree(ctx, objects, li, drills))
			const mesh = tree && copperMesh(ctx, tree, layer, kind)
			if (mesh) meshes.push(mesh)
		}
	})

	// Dielectric: one block from under the top copper to over the bottom copper, its edge banded by
	// layer (copper bands take the resin colour of the dielectric above them).
	const first = board.stack.findIndex(l => l.kind === "copper")
	const last = board.stack.length - 1 - [...board.stack].reverse().findIndex(l => l.kind === "copper")
	const inner = board.stack.slice(first + 1, last)
	if (inner.length) {
		const solid = difference(outline, pathsOf(drills))
		const edge = treeOf(outline)
		const top = ctx.z(inner[0]!.top), bottom = ctx.z(inner[inner.length - 1]!.bottom)
		let colourOf: StackLayer = inner[0]!
		// Its top and bottom faces: the bare board, seen in mask openings and through the mask.
		for (const side of ["top", "bottom"] as const) {
			const m = new MeshBuilder(ctx.cx, ctx.cy)
			m.cap(solid, side === "top" ? top : bottom, side === "top")
			if (!m.empty) meshes.push(m.mesh("dielectric", side === "top" ? "SURFACE-TOP" : "SURFACE-BOTTOM", ""))
		}
		inner.forEach(l => {
			if (l.kind === "dielectric") colourOf = l
			const m = new MeshBuilder(ctx.cx, ctx.cy)
			m.walls(edge, ctx.z(l.top), ctx.z(l.bottom))
			if (!m.empty) meshes.push(m.mesh("dielectric", colourOf.key, "", { core: colourOf.core }))
		})
		// Unplated holes show the bare board inside (plated ones are lined by their barrel).
		const m = new MeshBuilder(ctx.cx, ctx.cy)
		for (const d of drills) if (!d.plated) m.wallRing(d.path, true, top, bottom)
		if (!m.empty) meshes.push(m.mesh("dielectric", "NPTH", "", { core: true }))
	}

	// Masks: the board minus openings (pads by their expansion, mask-layer shapes) and holes.
	for (const side of ["top", "bottom"] as const) {
		const layer = board.stack.find(l => l.kind === "mask" && l.key === (side === "top" ? "TOPSOLDER" : "BOTTOMSOLDER"))
		const copperLayer = side === "top" ? board.stack[first]! : board.stack[last]!
		if (!layer) continue
		const openings = ([] as Paths64)
		for (const o of scene.objects) {
			const expansion = o.mask?.[side]
			const isOpening = o.layer === layer.key
			if ((expansion === undefined || expansion === null) && !isOpening) continue
			const paths = ([] as Paths64)
			for (const p of o.prims) primPaths(p, paths)
			if (!paths.length) continue
			const grown = expansion ? inflate(union(paths), expansion * SCALE, true) : paths
			for (const p of grown) openings.push(p)
		}
		for (const d of drills) if (!(side === "top" ? d.tentTop : d.tentBottom)) openings.push(d.path)
		const tree = difference(outline, union(openings))
		const m = new MeshBuilder(ctx.cx, ctx.cy)
		// The mask fills from its surface down to the dielectric, around the outer copper.
		const surface = side === "top" ? ctx.z(layer.top) : ctx.z(layer.bottom)
		const inside = side === "top" ? ctx.z(copperLayer.bottom) : ctx.z(copperLayer.top)
		m.cap(tree, surface, side === "top")
		if (side === "top") m.walls(tree, surface, inside)
		else m.walls(tree, inside, surface)
		if (!m.empty) meshes.push(m.mesh("mask", layer.key, ""))
	}

	// Silkscreen, per object type, just above the mask.
	for (const side of ["top", "bottom"] as const) {
		const key = side === "top" ? "TOPOVERLAY" : "BOTTOMOVERLAY"
		const z = side === "top" ? SILK_LIFT : ctx.z(board.thickness) - SILK_LIFT
		const byKind = new Map<string, Paths64>()
		for (const o of scene.objects) {
			if (o.layer !== key) continue
			const k = kindOf(o)
			let paths = byKind.get(k)
			if (!paths) byKind.set(k, (paths = ([] as Paths64)))
			for (const p of o.prims) primPaths(p, paths)
		}
		for (const [kind, paths] of byKind) {
			const tree = treeOf(run(ClipperLib.ClipType.ctIntersection, union(paths), outline))
			const m = new MeshBuilder(ctx.cx, ctx.cy)
			m.cap(tree, z, side === "top")
			if (!m.empty) meshes.push(m.mesh("silk", key, kind))
		}
	}

	// Plated barrels: a copper tube inside each plated hole, through the layers it spans.
	meshes.push(...barrels(ctx, drills.filter(d => d.plated)))
	return { meshes }
}

function barrels(ctx: Context, drills: Drill[], only?: string): GeoMesh[] {
	const out: GeoMesh[] = []
	const byKind = new Map<string, MeshBuilder>()
	for (const d of drills) {
		// Exactly the drill's contour (Altium's hole size is the finished hole): the barrel meets the
		// rings cut by the same contour edge to edge. (Inset by a plating thickness, it left a visible
		// gap between ring and barrel.)
		const ring = d.path
		const top = ctx.copper[d.from]!, bottom = ctx.copper[d.to]!
		const kind = only ?? d.kind
		let m = byKind.get(kind)
		if (!m) byKind.set(kind, (m = new MeshBuilder(ctx.cx, ctx.cy)))
		m.wallRing(ring, true, ctx.z(top.top), ctx.z(bottom.bottom), false)
	}
	for (const [k, m] of byKind) if (!m.empty) out.push(m.mesh("barrel", "MULTILAYER", k))
	return out
}

// The copper of some objects (a net, a part's pads, one via…) on every layer they are on, with the
// drills cut out, plus the barrels of their own plated holes: drawn in the highlight colour.
export function buildHighlightGeometry(scene: PcbScene, board: Board3d, ids: number[]): GeoMesh[] {
	const ctx = context(scene, board)
	const drills = drillsOf(ctx)
	const objects = ids.map(i => scene.objects[i]).filter((o): o is PcbObject => o !== undefined)
	const meshes: GeoMesh[] = []
	ctx.copper.forEach((layer, li) => {
		const on = objects.filter(o => layersOf(ctx, o).includes(layer.key))
		if (!on.length) return
		const tree = copperTree(ctx, on, li, drills)
		const mesh = tree && copperMesh(ctx, tree, layer, "")
		if (mesh) meshes.push(mesh)
	})
	const own = new Set(objects)
	const ownDrills: Drill[] = []
	const all = drillsOf({ ...ctx, scene: { ...scene, objects: [...own] } })
	for (const d of all) if (d.plated) ownDrills.push(d)
	meshes.push(...barrels(ctx, ownDrills, ""))
	return meshes
}
