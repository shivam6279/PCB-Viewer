import { describe, expect, test } from "vitest"
import * as THREE from "three"
import { colorRef, parse3dConfig, stackThickness, type Board3d, type Board3dBody } from "./board3d"
import { buildBoardGeometry, buildHighlightGeometry, MM, type GeoMesh } from "./board-geometry"
import { bodyMatrix } from "./components"
import { componentAtPoint } from "./engine"
import { stepStyles } from "./step-styles"
import type { PcbScene } from "../pcb/scene"

describe("board 3D configuration", () => {
	test("Windows colours are 0x00BBGGRR", () => {
		expect(colorRef("5360095")).toEqual([0xdf / 255, 0xc9 / 255, 0x51 / 255]) // Cubli copper #DFC951
		expect(colorRef(undefined)).toBeNull()
	})

	test("reads the saved 3D view configuration (Cubli: Altium 3D White)", () => {
		const config = [
			"RECORD=Board",
			"CFGALL.CONFIGURATIONDESC=Altium%203D%20White",
			"CFG3D.TOPSOLDERMASKCOLOR=15987699",
			"CFG3D.TOPSOLDERMASKCOLOROPACITY=0.900000",
			"CFG3D.BOTSOLDERMASKCOLOROPACITY=0.800000",
			"CFG3D.COPPERCOLOR=5360095",
			"CFG3D.TOPSILKSCREENCOLOR=0",
		].join("`")
		const c = parse3dConfig(config)
		expect(c.topMask).toEqual([0xf3 / 255, 0xf3 / 255, 0xf3 / 255])
		expect(c.topMaskOpacity).toBe(0.9)
		expect(c.bottomMaskOpacity).toBe(0.8)
		expect(c.topSilk).toEqual([0, 0, 0])
	})

	test("board thickness is the V9 stack's copper and dielectric heights", () => {
		const items = [
			["V9_STACK_LAYER0_LAYERID", "16973834"],
			["V9_STACK_LAYER0_DIELHEIGHT", "0.4mil"],
			["V9_STACK_LAYER1_LAYERID", "16777217"],
			["V9_STACK_LAYER1_COPTHICK", "1.4mil"],
			["V9_STACK_LAYER2_LAYERID", "17039361"],
			["V9_STACK_LAYER2_DIELHEIGHT", "60mil"],
		].map(([key, value]) => ({ key: key!, value: value! }))
		expect(stackThickness(items)).toBeCloseTo(61.8)
		expect(stackThickness([])).toBeCloseTo(62.99) // 1.6 mm default
	})
})

describe("STEP colours", () => {
	const file = (body: string) => `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${body}\nENDSEC;\nEND-ISO-10303-21;`
	const style = (id: number, target: number, colour: number) =>
		[
			`#${id} = STYLED_ITEM('',(#${id + 1}),#${target});`,
			`#${id + 1} = PRESENTATION_STYLE_ASSIGNMENT((#${id + 2}));`,
			`#${id + 2} = SURFACE_STYLE_USAGE(.BOTH.,#${id + 3});`,
			`#${id + 3} = SURFACE_SIDE_STYLE('',(#${id + 4}));`,
			`#${id + 4} = SURFACE_STYLE_FILL_AREA(#${id + 5});`,
			`#${id + 5} = FILL_AREA_STYLE('',(#${id + 6}));`,
			`#${id + 6} = FILL_AREA_STYLE_COLOUR('',#${colour});`,
		].join("\n")
	const solid = (id: number, shell: number, faces: number[]) =>
		[`#${id} = MANIFOLD_SOLID_BREP('',#${shell});`, `#${shell} = CLOSED_SHELL('',(${faces.map(f => `#${f}`).join(",")}));`, ...faces.map(f => `#${f} = ADVANCED_FACE('',(),#1,.T.);`)].join("\n")
	const colours = `#900 = COLOUR_RGB('',1.,0.,0.);\n#901 = COLOUR_RGB('',0.,0.,1.);\n#902 = COLOUR_RGB('',0.,1.,0.);`

	test("face styles map onto each solid's faces in shell order", () => {
		const s = stepStyles(file([colours, solid(10, 11, [12, 13]), `#20 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#10),#1);`, style(100, 13, 900)].join("\n")))!
		expect(s.solids).toEqual([{ color: null, faces: [null, [1, 0, 0]] }])
	})

	test("one-solid part: the style listed first wins (CAP 1206-0.8mm, LED 0603 Lens GREEN)", () => {
		const rep = `#20 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#10),#1);`
		const partFirst = stepStyles(file([colours, solid(10, 11, [12]), rep, style(100, 20, 901), style(200, 10, 900)].join("\n")))!
		expect(partFirst.solids[0]!.color).toEqual([0, 0, 1])
		const solidFirst = stepStyles(file([colours, solid(10, 11, [12]), rep, style(100, 10, 900), style(200, 20, 901)].join("\n")))!
		expect(solidFirst.solids[0]!.color).toEqual([1, 0, 0])
	})

	test("several solids: each keeps its own colour over the part's (MPU6050 / XB3)", () => {
		const s = stepStyles(
			file([colours, solid(10, 11, [12]), solid(30, 31, [32]), `#20 = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#10,#30),#1);`, style(100, 20, 901), style(200, 10, 900)].join("\n")),
		)!
		expect(s.solids.map(x => x.color)).toEqual([
			[1, 0, 0],
			[0, 0, 1],
		])
	})

	test("no styles: null", () => {
		expect(stepStyles(file(solid(10, 11, [12])))).toBeNull()
	})
})

describe("body placement", () => {
	const frame = { cx: 0, cy: 0, thickness: 1.6 }
	const body = (side: "top" | "bottom", rz: number, dz = 0): Board3dBody => ({
		component: 0, side, contour: [], standoff: 0, height: 0, color: [0.5, 0.5, 0.5], opacity: 1, model: "0",
		x: 1000, y: 0, rx: 0, ry: 0, rz, dz,
	})
	const at = (b: Board3dBody, p: [number, number, number]) => new THREE.Vector3(...p).applyMatrix4(bodyMatrix(b, frame))

	test("top: translated to the model origin, turned by the model's own rotation", () => {
		const p = at(body("top", 90, 10), [1, 0, 2])
		expect(p.x).toBeCloseTo(25.4)
		expect(p.y).toBeCloseTo(1)
		expect(p.z).toBeCloseTo(2 + 0.254)
	})

	test("bottom: turned over about x and hung below the bottom surface", () => {
		const p = at(body("bottom", 0, 10), [1, 1, 2])
		expect(p.x).toBeCloseTo(25.4 + 1)
		expect(p.y).toBeCloseTo(-1)
		expect(p.z).toBeCloseTo(-1.6 - 0.254 - 2)
	})
})

test("a click on the board picks the smallest component under it on that side", () => {
	const c = (outline: [number, number, number, number], side: "top" | "bottom") => ({ outline, side })
	const scene = { components: [c([0, 0, 100, 100], "top"), c([10, 10, 20, 20], "top"), c([10, 10, 20, 20], "bottom")] } as unknown as PcbScene
	expect(componentAtPoint(scene, 15, 15, "top")).toBe(1)
	expect(componentAtPoint(scene, 50, 50, "top")).toBe(0)
	expect(componentAtPoint(scene, 15, 15, "bottom")).toBe(2)
	expect(componentAtPoint(scene, 500, 500, "top")).toBeNull()
})

describe("layered board geometry", () => {
	// A 100 x 100 mil pour on Top with a via of the same net in its middle (20 mil pad, 10 mil hole).
	const scene = {
		bounds: [0, 0, 200, 200],
		outline: [0, 0, 200, 0, 200, 200, 0, 200],
		cutouts: [],
		layers: [],
		components: [],
		objects: [
			{ id: 0, kind: "region", layer: "TOP", net: "N", component: null, pour: true, prims: [{ t: "poly", rings: [[50, 50, 150, 50, 150, 150, 50, 150]] }], holes: [], bbox: [50, 50, 150, 150], at: [50, 50] },
			{ id: 1, kind: "via", layer: "MULTILAYER", span: ["TOP", "BOTTOM"], net: "N", component: null, prims: [{ t: "circle", x: 100, y: 100, r: 10 }], holes: [{ t: "circle", x: 100, y: 100, r: 5 }], bbox: [90, 90, 110, 110], at: [100, 100], mask: { top: null, bottom: null } },
		],
	} as unknown as PcbScene
	const board = {
		thickness: 63,
		stack: [
			{ kind: "mask", key: "TOPSOLDER", name: "", top: 0, bottom: 0.4, core: false },
			{ kind: "copper", key: "TOP", name: "", top: 0.4, bottom: 1.8, core: false },
			{ kind: "dielectric", key: "D", name: "", top: 1.8, bottom: 61.2, core: true },
			{ kind: "copper", key: "BOTTOM", name: "", top: 61.2, bottom: 62.6, core: false },
			{ kind: "mask", key: "BOTTOMSOLDER", name: "", top: 62.6, bottom: 63, core: false },
		],
	} as unknown as Board3d
	// Area of the faces facing up (+z) in a mesh, in mils².
	const upArea = (m: GeoMesh) => {
		let a = 0
		for (let i = 0; i < m.index.length; i += 3) {
			const [p, q, r] = [m.index[i]!, m.index[i + 1]!, m.index[i + 2]!].map(k => [m.positions[k * 3]!, m.positions[k * 3 + 1]!, m.normals[k * 3 + 2]!] as const) as [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]]
			if (p[2] < 0.9) continue
			a += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2
		}
		return a / (MM * MM)
	}

	test("a net's copper keeps the holes drilled through it", () => {
		const meshes = buildHighlightGeometry(scene, board, [0, 1])
		const top = meshes.find(m => m.role === "copper" && m.layer === "TOP")!
		expect(upArea(top)).toBeCloseTo(100 * 100 - Math.PI * 25, -1) // the pour, minus the drill
		const bottom = meshes.find(m => m.role === "copper" && m.layer === "BOTTOM")!
		expect(bottom).toBeDefined() // the via's ring on the bottom layer
		expect(meshes.some(m => m.role === "barrel")).toBe(true)
	})

	test("the board: copper per layer and type, a drilled dielectric, masks with openings, a barrel", () => {
		const g = buildBoardGeometry(scene, board)
		const roles = new Set(g.meshes.map(m => `${m.role}:${m.layer}:${m.kind}`))
		expect(roles).toContain("copper:TOP:polygon")
		expect(roles).toContain("copper:TOP:via")
		expect(roles).toContain("copper:BOTTOM:via")
		expect(roles).toContain("barrel:MULTILAYER:via")
		expect(roles).toContain("mask:TOPSOLDER:")
		const surface = g.meshes.find(m => m.layer === "SURFACE-TOP")!
		expect(upArea(surface)).toBeCloseTo(200 * 200 - Math.PI * 25, -1) // the board, minus the drill
	})
})
