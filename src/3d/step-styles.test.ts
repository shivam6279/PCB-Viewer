import { describe, expect, it } from "vitest"
import { pairSolids, type StepRgb, type StepSolid } from "./step-styles"

const solid = (faces: number, color: StepRgb): StepSolid => ({ color, faces: Array(faces).fill(null) })
const gold: StepRgb = [0.75, 0.75, 0], black: StepRgb = [0, 0, 0], blue: StepRgb = [0.15, 0.36, 1]

describe("pairSolids", () => {
	it("pairs one to one when the counts agree", () => {
		const solids = [solid(6, gold), solid(48, blue)]
		expect(pairSolids([6, 48], solids)).toEqual(solids)
	})

	it("pairs a sub-part placed twice with its solids again", () => {
		// a module body, then a header (a pin and a housing) placed twice
		const solids = [solid(48, blue), solid(14, gold), solid(14, black)]
		const paired = pairSolids([48, 14, 14, 14, 14], solids)
		expect(paired.map(s => s?.color)).toEqual([blue, gold, black, gold, black])
	})

	it("leaves a face count unpaired when its meshes don't come in whole multiples", () => {
		const solids = [solid(48, blue), solid(14, gold), solid(14, black)]
		expect(pairSolids([48, 48, 14, 14, 14], solids).map(s => s?.color)).toEqual([blue, blue, undefined, undefined, undefined])
	})
})
