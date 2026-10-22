import { describe, expect, test } from "vitest"
import { evaluateSpecialString } from "./special-string-expression"

const params: Record<string, string> = { documentname: "Top.SchDoc", projectname: "Cubli.PrjPcb", sheetnumber: "1", sheettotal: "7" }
const lookup = (name: string) => params[name.toLowerCase()]

describe("special string expressions", () => {
	test("Copy and Length cut the extension off a file name", () => {
		expect(evaluateSpecialString("Copy(DocumentName, 1, Length(DocumentName) - 7)", lookup)).toBe("Top")
		expect(evaluateSpecialString("Copy(ProjectName, 1, Length(ProjectName) - 7)", lookup)).toBe("Cubli")
	})

	test("+ joins text, numbers add", () => {
		expect(evaluateSpecialString("'Sheet ' + SheetNumber + ' of ' + SheetTotal", lookup)).toBe("Sheet 1 of 7")
		expect(evaluateSpecialString("2 + 3 * 4", lookup)).toBe("14")
		expect(evaluateSpecialString("'it''s'", lookup)).toBe("it's")
		expect(evaluateSpecialString("UpperCase(Copy(DocumentName, 5, 3))", lookup)).toBe("SCH")
	})

	test("an unknown name or a bad expression gives nothing", () => {
		expect(evaluateSpecialString("Missing + 'x'", lookup)).toBeUndefined()
		expect(evaluateSpecialString("Copy(DocumentName, 1", lookup)).toBeUndefined()
		expect(evaluateSpecialString("Nope(1)", lookup)).toBeUndefined()
		expect(evaluateSpecialString("Length(DocumentName) - DocumentName", lookup)).toBeUndefined()
	})
})
