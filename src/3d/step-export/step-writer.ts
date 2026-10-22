// Writing STEP (AP214) records: products and an assembly that places them, colours, and solids made
// by extruding a flat outline (a board, a copper layer, silkscreen) with true cylinders for round
// holes. Lengths are mm. Pure: no DOM.

export type Vec3 = [number, number, number]

// A ring of a flat outline (mm): a polygon (x,y pairs), a circle, or a path of lines and arcs (each
// segment from its point to the next; an arc about its centre, counter-clockwise or not).
export type PathSeg = { x: number; y: number; arc?: { cx: number; cy: number; r: number; ccw: boolean } }
export type Ring = { t: "poly"; pts: number[] } | { t: "circle"; x: number; y: number; r: number } | { t: "path"; segs: PathSeg[] }

// One region of an outline: its outer ring (counter-clockwise) and the holes in it. outerRing, when
// given, is the outer ring with its true arcs (a solid's walls then follow them; outer stays a polygon).
export interface Region {
	outer: number[]
	outerRing?: Ring
	holes: Ring[]
}

// A STEP real: always with a decimal point ("2.", "0.5", "1.5E-07"), rounded to 1e-9 mm.
export const num = (v: number) => {
	const r = Number.isFinite(v) ? Math.round(v * 1e9) / 1e9 : 0
	if (r === 0) return "0."
	const s = String(r)
	if (s.includes("e")) {
		const [mantissa, exponent] = s.split("e")
		return `${mantissa!.includes(".") ? mantissa : mantissa + "."}E${exponent}`
	}
	return s.includes(".") ? s : s + "."
}
const str = (s: string) => `'${s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, "?")}'`

export class StepWriter {
	private next = 1
	// Records are encoded to bytes in batches as they are written: a board with its copper and parts is
	// millions of records, and keeping them all as strings to the end holds hundreds of MB.
	private pending: string[] = []
	private chunks: Uint8Array[] = []
	private context: number | null = null
	private appContext: number | null = null
	private origin: number | null = null
	private points = new Map<string, number>()
	private dirs = new Map<string, number>()
	private digest = FNV_OFFSET

	add(body: string): number {
		const id = this.next++
		this.line(`#${id}=${body};`)
		return id
	}

	// Reserves a run of ids for records written elsewhere (a copied file), returning the first.
	reserve(count: number): number {
		const first = this.next
		this.next += count
		return first
	}

	push(line: string) {
		this.line(line)
	}

	private line(text: string) {
		this.pending.push(text)
		this.digest = fnv(text, this.digest)
		if (this.pending.length >= 20000) this.flush()
	}

	// A short tag for everything written so far: the same records give the same tag. Part names carry
	// one (see exportStep), so parts from two different files never share a name.
	tag(): string {
		return hex(this.digest)
	}

	private flush() {
		if (!this.pending.length) return
		this.chunks.push(latin1(this.pending.join("\n") + "\n"))
		this.pending = []
	}

	point(x: number, y: number, z: number): number {
		const key = `${num(x)},${num(y)},${num(z)}`
		let id = this.points.get(key)
		if (id === undefined) this.points.set(key, (id = this.add(`CARTESIAN_POINT('',(${key}))`)))
		return id
	}

	dir(x: number, y: number, z: number): number {
		const l = Math.hypot(x, y, z) || 1
		const key = `${num(x / l)},${num(y / l)},${num(z / l)}`
		let id = this.dirs.get(key)
		if (id === undefined) this.dirs.set(key, (id = this.add(`DIRECTION('',(${key}))`)))
		return id
	}

	axis(at: Vec3, z: Vec3 = [0, 0, 1], x: Vec3 = [1, 0, 0]): number {
		return this.add(`AXIS2_PLACEMENT_3D('',#${this.point(...at)},#${this.dir(...z)},#${this.dir(...x)})`)
	}

	// The millimetre geometric context every representation written here shares.
	mmContext(): number {
		if (this.context !== null) return this.context
		const mm = this.add("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))")
		const rad = this.add("(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))")
		const sr = this.add("(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())")
		const unc = this.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${mm},'distance_accuracy_value','confusion accuracy')`)
		this.context = this.add(
			`(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr})) REPRESENTATION_CONTEXT('Context','3D Context with UNIT and UNCERTAINTY'))`,
		)
		return this.context
	}

	// The axis at the origin, shared by every representation written here.
	originAxis(): number {
		return (this.origin ??= this.axis([0, 0, 0]))
	}

	// Starts a part of its own: the records written from here share nothing with those before (units,
	// origin, points, directions), as in a STEP file of one part. CAD that re-reads the file finds each
	// part by its own records: parts sharing them were lost on reopening (a board's own layers gone,
	// mates on them broken), while the parts copied whole from their own files stayed.
	beginPart() {
		this.context = null
		this.appContext = null
		this.origin = null
		this.points = new Map()
		this.dirs = new Map()
	}

	private application(): number {
		if (this.appContext !== null) return this.appContext
		this.appContext = this.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')")
		this.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${this.appContext})`)
		return this.appContext
	}

	// A product with its shape representation (built from `items` in the mm context). Returns its
	// product definition and representation.
	product(name: string, repType: string, items: number[]): { definition: number; representation: number } {
		const app = this.application()
		const pc = this.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`)
		const product = this.add(`PRODUCT(${str(name)},${str(name)},'',(#${pc}))`)
		this.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${product}))`)
		const formation = this.add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`)
		const pdc = this.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`)
		const definition = this.add(`PRODUCT_DEFINITION('design','',#${formation},#${pdc})`)
		const pds = this.add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`)
		const representation = this.add(`${repType}('',(${items.map(i => "#" + i).join(",")}),#${this.mmContext()})`)
		this.add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${representation})`)
		return { definition, representation }
	}

	// Places a part (its product definition and representation, placed by `childAxis` in its own
	// representation) in an assembly at `parentAxis`, an item of the assembly's representation.
	instance(name: string, assembly: { definition: number; representation: number }, part: { definition: number; representation: number }, childAxis: number, parentAxis: number, n: number) {
		const transform = this.add(`ITEM_DEFINED_TRANSFORMATION('','',#${childAxis},#${parentAxis})`)
		const rel = this.add(
			`(REPRESENTATION_RELATIONSHIP('','',#${part.representation},#${assembly.representation}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${transform}) SHAPE_REPRESENTATION_RELATIONSHIP())`,
		)
		const nauo = this.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${n}',${str(name)},'',#${assembly.definition},#${part.definition},$)`)
		const pds = this.add(`PRODUCT_DEFINITION_SHAPE('Placement','Placement of an item',#${nauo})`)
		this.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rel},#${pds})`)
	}

	// Colours solids (items of representations in the mm context).
	colour(items: { item: number; rgb: [number, number, number] }[]) {
		if (!items.length) return
		const styled = items.map(({ item, rgb }) => {
			const colour = this.add(`COLOUR_RGB('',${num(rgb[0])},${num(rgb[1])},${num(rgb[2])})`)
			const fill = this.add(`FILL_AREA_STYLE_COLOUR('',#${colour})`)
			const area = this.add(`FILL_AREA_STYLE('',(#${fill}))`)
			const surface = this.add(`SURFACE_STYLE_FILL_AREA(#${area})`)
			const side = this.add(`SURFACE_SIDE_STYLE('',(#${surface}))`)
			const usage = this.add(`SURFACE_STYLE_USAGE(.BOTH.,#${side})`)
			const assignment = this.add(`PRESENTATION_STYLE_ASSIGNMENT((#${usage}))`)
			return this.add(`STYLED_ITEM('color',(#${assignment}),#${item})`)
		})
		this.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.map(s => "#" + s).join(",")}),#${this.mmContext()})`)
	}

	// A solid: the region extruded from z0 up to z1 (MANIFOLD_SOLID_BREP). Polygon edges are lines,
	// circles and arcs true circles with cylindrical walls (a whole circle split in two half faces).
	prism(region: Region, z0: number, z1: number): number {
		const faces: number[] = []
		const top: number[] = [] // loops of the top face (first: outer)
		const bottom: number[] = []
		const rings: Ring[] = [region.outerRing ?? { t: "poly", pts: region.outer }, ...region.holes]
		rings.forEach((ring, k) => {
			const hole = k > 0
			if (ring.t === "circle") {
				const { x, y, r } = ring
				// Two half circles at each height, joined by two vertical seams (at angle 0 and 180).
				const tA = this.vertex(x + r, y, z1), tB = this.vertex(x - r, y, z1)
				const bA = this.vertex(x + r, y, z0), bB = this.vertex(x - r, y, z0)
				const circ = (z: number) => this.add(`CIRCLE('',#${this.axis([x, y, z])},${num(r)})`)
				const ct = circ(z1), cb = circ(z0)
				// Arcs run counter-clockwise (seen from +z): A -> B is the upper half, B -> A the lower.
				const tAB = this.edge(tA, tB, ct), tBA = this.edge(tB, tA, ct)
				const bAB = this.edge(bA, bB, cb), bBA = this.edge(bB, bA, cb)
				const vA = this.lineEdge(bA, tA, [x + r, y, z0], [x + r, y, z1]), vB = this.lineEdge(bB, tB, [x - r, y, z0], [x - r, y, z1])
				// A hole runs clockwise in the top face, counter-clockwise in the bottom one.
				top.push(this.loop([[tBA, false], [tAB, false]], hole))
				bottom.push(this.loop([[bAB, true], [bBA, true]], hole))
				// The wall faces into the hole (or out, for a round outer ring): its surface normal points
				// away from the material.
				const cyl = this.add(`CYLINDRICAL_SURFACE('',#${this.axis([x, y, z0])},${num(r)})`)
				const sense = !hole
				for (const [b, t, v0, v1] of [[bAB, tAB, vA, vB], [bBA, tBA, vB, vA]] as const) {
					// Going around the half wall: along the bottom arc, up a seam, back along the top arc, down.
					const loop = hole
						? this.edgeLoop([[v0, true], [t, true], [v1, false], [b, false]])
						: this.edgeLoop([[b, true], [v1, true], [t, false], [v0, false]])
					faces.push(this.add(`ADVANCED_FACE('',(#${this.add(`FACE_OUTER_BOUND('',#${loop},.T.)`)}),#${cyl},${sense ? ".T." : ".F."})`))
				}
				return
			}
			const segs: PathSeg[] = ring.t === "path" ? ring.segs : Array.from({ length: ring.pts.length / 2 }, (_, i) => ({ x: ring.pts[i * 2]!, y: ring.pts[i * 2 + 1]! }))
			const n = segs.length
			const tv: number[] = [], bv: number[] = []
			for (const s of segs) {
				tv.push(this.vertex(s.x, s.y, z1))
				bv.push(this.vertex(s.x, s.y, z0))
			}
			// Each segment's edge at a height: a line, or an arc of a circle about +z (an edge running
			// clockwise goes against the circle's sense).
			const segEdge = (i: number, from: number, to: number, z: number) => {
				const a = segs[i]!, b = segs[(i + 1) % n]!
				if (!a.arc) return this.lineEdge(from, to, [a.x, a.y, z], [b.x, b.y, z])
				const circle = this.add(`CIRCLE('',#${this.axis([a.arc.cx, a.arc.cy, z])},${num(a.arc.r)})`)
				return this.add(`EDGE_CURVE('',#${from},#${to},#${circle},${a.arc.ccw ? ".T." : ".F."})`)
			}
			const te: number[] = [], be: number[] = [], ve: number[] = []
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n
				te.push(segEdge(i, tv[i]!, tv[j]!, z1))
				be.push(segEdge(i, bv[i]!, bv[j]!, z0))
				ve.push(this.lineEdge(bv[i]!, tv[i]!, [segs[i]!.x, segs[i]!.y, z0], [segs[i]!.x, segs[i]!.y, z1]))
			}
			// The ring keeps the material on its left: counter-clockwise outer, clockwise holes.
			top.push(this.loop(te.map(e => [e, true] as [number, boolean]), hole))
			bottom.push(this.loop([...be].reverse().map(e => [e, false] as [number, boolean]), hole))
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n
				const a = segs[i]!, b = segs[j]!
				// The wall, its normal pointing away from the material (to the right of the edge's
				// direction): a plane, or a cylinder (whose normal points out from its axis: away from the
				// material when the arc runs counter-clockwise, the material inside it).
				const surface = a.arc
					? { id: this.add(`CYLINDRICAL_SURFACE('',#${this.axis([a.arc.cx, a.arc.cy, z0])},${num(a.arc.r)})`), sense: a.arc.ccw }
					: { id: this.add(`PLANE('',#${this.axis([a.x, a.y, z0], [b.y - a.y, -(b.x - a.x), 0], [b.x - a.x, b.y - a.y, 0])})`), sense: true }
				const loop = this.edgeLoop([[be[i]!, true], [ve[j]!, true], [te[i]!, false], [ve[i]!, false]])
				faces.push(this.add(`ADVANCED_FACE('',(#${this.add(`FACE_OUTER_BOUND('',#${loop},.T.)`)}),#${surface.id},${surface.sense ? ".T." : ".F."})`))
			}
		})
		const planeTop = this.add(`PLANE('',#${this.axis([0, 0, z1])})`)
		const planeBottom = this.add(`PLANE('',#${this.axis([0, 0, z0], [0, 0, -1], [1, 0, 0])})`)
		faces.push(this.add(`ADVANCED_FACE('',(${top.map(l => "#" + l).join(",")}),#${planeTop},.T.)`))
		faces.push(this.add(`ADVANCED_FACE('',(${bottom.map(l => "#" + l).join(",")}),#${planeBottom},.T.)`))
		const shell = this.add(`CLOSED_SHELL('',(${faces.map(f => "#" + f).join(",")}))`)
		return this.add(`MANIFOLD_SOLID_BREP('',#${shell})`)
	}

	// A flat face at height z facing up (+z) or down: the region's outline with its holes. Gathered
	// into SHELL_BASED_SURFACE_MODELs (surfaceModel) for a layer drawn as a sheet, which costs a fifth
	// of a solid's records (no walls, one set of edges).
	face(region: Region, z: number, up: boolean): number {
		const loops = [{ t: "poly" as const, pts: region.outer }, ...region.holes].map((ring, k) => {
			if (ring.t !== "poly") throw new Error("face: polygon rings only")
			let pts = ring.pts
			// Seen from below the face's outer ring runs clockwise: reversed, it keeps the material on its left.
			if (!up) {
				const r: number[] = []
				for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i]!, pts[i + 1]!)
				pts = r
			}
			const n = pts.length / 2
			const vs = Array.from({ length: n }, (_, i) => this.vertex(pts[i * 2]!, pts[i * 2 + 1]!, z))
			const edges = vs.map((v, i) => {
				const j = (i + 1) % n
				return [this.lineEdge(v, vs[j]!, [pts[i * 2]!, pts[i * 2 + 1]!, z], [pts[j * 2]!, pts[j * 2 + 1]!, z]), true] as [number, boolean]
			})
			return this.loop(edges, k > 0)
		})
		const plane = this.add(`PLANE('',#${this.axis([0, 0, z], [0, 0, up ? 1 : -1], [1, 0, 0])})`)
		return this.add(`ADVANCED_FACE('',(${loops.map(l => "#" + l).join(",")}),#${plane},.T.)`)
	}

	// The plating of a round hole: a tube from z0 up to z1, its faces looking into the hole (two half
	// cylinders joined by two seams, as the board's hole walls are).
	tube(x: number, y: number, r: number, z0: number, z1: number): number[] {
		const tA = this.vertex(x + r, y, z1), tB = this.vertex(x - r, y, z1)
		const bA = this.vertex(x + r, y, z0), bB = this.vertex(x - r, y, z0)
		const ct = this.add(`CIRCLE('',#${this.axis([x, y, z1])},${num(r)})`)
		const cb = this.add(`CIRCLE('',#${this.axis([x, y, z0])},${num(r)})`)
		const tAB = this.edge(tA, tB, ct), tBA = this.edge(tB, tA, ct)
		const bAB = this.edge(bA, bB, cb), bBA = this.edge(bB, bA, cb)
		const vA = this.lineEdge(bA, tA, [x + r, y, z0], [x + r, y, z1]), vB = this.lineEdge(bB, tB, [x - r, y, z0], [x - r, y, z1])
		const cyl = this.add(`CYLINDRICAL_SURFACE('',#${this.axis([x, y, z0])},${num(r)})`)
		return ([[bAB, tAB, vA, vB], [bBA, tBA, vB, vA]] as const).map(([b, t, v0, v1]) => {
			const loop = this.edgeLoop([[v0, true], [t, true], [v1, false], [b, false]])
			return this.add(`ADVANCED_FACE('',(#${this.add(`FACE_OUTER_BOUND('',#${loop},.T.)`)}),#${cyl},.F.)`)
		})
	}

	// Faces as one surface body item: one open shell per face.
	surfaceModel(faces: number[]): number {
		const shells = faces.map(f => this.add(`OPEN_SHELL('',(#${f}))`))
		return this.add(`SHELL_BASED_SURFACE_MODEL('',(${shells.map(s => "#" + s).join(",")}))`)
	}

	private vertex(x: number, y: number, z: number): number {
		return this.add(`VERTEX_POINT('',#${this.point(x, y, z)})`)
	}

	private edge(from: number, to: number, curve: number): number {
		return this.add(`EDGE_CURVE('',#${from},#${to},#${curve},.T.)`)
	}

	private lineEdge(from: number, to: number, a: Vec3, b: Vec3): number {
		const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
		const length = Math.hypot(...d) || 1e-9
		const line = this.add(`LINE('',#${this.point(...a)},#${this.add(`VECTOR('',#${this.dir(...d)},${num(length)})`)})`)
		return this.edge(from, to, line)
	}

	private edgeLoop(edges: [number, boolean][]): number {
		return this.add(`EDGE_LOOP('',(${edges.map(([e, f]) => `#${this.add(`ORIENTED_EDGE('',*,*,#${e},${f ? ".T." : ".F."})`)}`).join(",")}))`)
	}

	// A face bound: the outer one (FACE_OUTER_BOUND) or a hole (FACE_BOUND).
	private loop(edges: [number, boolean][], hole: boolean): number {
		return this.add(`${hole ? "FACE_BOUND" : "FACE_OUTER_BOUND"}('',#${this.edgeLoop(edges)},.T.)`)
	}

	// The whole file: header, then every record. STEP is 8-bit text, written byte for byte (a copied
	// model's characters are kept as they were).
	bytes(name: string): Uint8Array {
		this.flush()
		const date = new Date().toISOString().slice(0, 19)
		const head = latin1(
			[
				"ISO-10303-21;",
				"HEADER;",
				"FILE_DESCRIPTION(('PCB-Viewer board export'),'2;1');",
				`FILE_NAME(${str(name)},'${date}',(''),(''),'PCB-Viewer','PCB-Viewer','');`,
				"FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
				"ENDSEC;",
				"DATA;",
				"",
			].join("\n"),
		)
		const parts = [head, ...this.chunks, latin1("ENDSEC;\nEND-ISO-10303-21;\n")]
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
		let at = 0
		for (const p of parts) {
			out.set(p, at)
			at += p.length
		}
		return out
	}
}

// FNV-1a (32 bit) over a string's char codes or a file's bytes, continuing from `h`.
const FNV_OFFSET = 0x811c9dc5
function fnv(data: string | Uint8Array, h = FNV_OFFSET): number {
	if (typeof data === "string") for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data.charCodeAt(i), 0x01000193)
	else for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i]!, 0x01000193)
	return Math.imul(h ^ 10, 0x01000193) // the line's end
}
const hex = (h: number) => (h >>> 0).toString(16).padStart(8, "0").slice(0, 6)

// The tag of a file's contents (as StepWriter.tag).
export const contentTag = (bytes: Uint8Array) => hex(fnv(bytes))

function latin1(text: string): Uint8Array {
	const out = new Uint8Array(text.length)
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
	return out
}
