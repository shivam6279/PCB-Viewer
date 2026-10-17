import { expect, test } from "vitest"
import occtFactory from "occt-import-js"
import { renumber, stepEntities, stepRoots, withItem } from "./step-file"
import { num, StepWriter } from "./step-writer"

const MODEL = [
	"ISO-10303-21;",
	"HEADER;",
	"FILE_NAME('a;b #9','',(''),(''),'','','');",
	"ENDSEC;",
	"DATA;",
	"#10=PRODUCT_DEFINITION('design','',#11,#12);",
	"#13=PRODUCT_DEFINITION_SHAPE('','',#10);",
	"#14=SHAPE_DEFINITION_REPRESENTATION(#13,#20);",
	"/* a comment; with #99 */",
	"#20=SHAPE_REPRESENTATION('it''s; #5',(#21,#25),#30);",
	"#21=AXIS2_PLACEMENT_3D('',#22,#23,#24);",
	"#22=CARTESIAN_POINT('',(0.,0.,5.E-2));",
	"#23=DIRECTION('',(0.E0,-1.E0,0.E0));",
	"#24=DIRECTION('',(1.,0.,0.));",
	"#25=AXIS2_PLACEMENT_3D('',#26,$,$);",
	"#26=CARTESIAN_POINT('',(0.,0.,0.));",
	"ENDSEC;",
	"END-ISO-10303-21;",
].join("\n")

test("a STEP file's records: strings and comments never split or renumber anything", () => {
	const entities = stepEntities(MODEL)
	expect(entities.map(e => e.id)).toEqual([10, 13, 14, 20, 21, 22, 23, 24, 25, 26])
	const rep = entities.find(e => e.id === 20)!
	expect(rep.body).toBe("SHAPE_REPRESENTATION('it''s; #5',(#21,#25),#30)")
	expect(renumber(rep.body, id => id + 100)).toBe("SHAPE_REPRESENTATION('it''s; #5',(#121,#125),#130)")
	expect(withItem(rep.body, 7)).toBe("SHAPE_REPRESENTATION('it''s; #5',(#21,#25,#7),#30)")
})

test("a model's root is placed by an axis that is its own frame, never a turned or moved one", () => {
	const roots = stepRoots(stepEntities(MODEL))
	// #21 is moved and turned; #25 is the origin with its directions left unset.
	expect(roots).toEqual([{ productDefinition: 10, representation: 20, axis: 25 }])
	const withoutOrigin = MODEL.replace("(#21,#25)", "(#21)")
	expect(stepRoots(stepEntities(withoutOrigin))[0]!.axis).toBeNull()
})

test("STEP reals always carry a decimal point", () => {
	expect([num(2), num(0.5), num(-1.25), num(0), num(1.5e-7), num(1e-13)]).toEqual(["2.", "0.5", "-1.25", "0.", "1.5E-7", "0."])
})

test("an extruded outline with a round hole and a polygon hole reads back as one solid", async () => {
	const w = new StepWriter()
	const solid = w.prism(
		{
			outer: [0, 0, 20, 0, 20, 10, 0, 10],
			holes: [
				{ t: "circle", x: 5, y: 5, r: 1.5 },
				{ t: "poly", pts: [12, 3, 12, 7, 16, 7, 16, 3] }, // clockwise
			],
		},
		0,
		1.6,
	)
	const part = w.product("Board", "ADVANCED_BREP_SHAPE_REPRESENTATION", [w.originAxis(), solid])
	const asm = w.product("Asm", "SHAPE_REPRESENTATION", [w.originAxis()])
	w.instance("Board", asm, part, w.originAxis(), w.originAxis(), 1)
	w.colour([{ item: solid, rgb: [0, 0.5, 0] }])
	const occt = await occtFactory()
	const r = occt.ReadStepFile(w.bytes("t.step"), null)
	expect(r.success).toBe(true)
	expect(r.meshes.length).toBe(1)
	const pos = r.meshes[0].attributes.position.array as number[]
	const zs = pos.filter((_: number, i: number) => i % 3 === 2)
	expect(Math.min(...zs)).toBeCloseTo(0, 6)
	expect(Math.max(...zs)).toBeCloseTo(1.6, 6)
	// The hole's wall: points on the cylinder of radius 1.5 about (5, 5).
	let onCylinder = 0
	for (let i = 0; i < pos.length; i += 3) if (Math.abs(Math.hypot(pos[i]! - 5, pos[i + 1]! - 5) - 1.5) < 1e-3) onCylinder++
	expect(onCylinder).toBeGreaterThan(8)
})
