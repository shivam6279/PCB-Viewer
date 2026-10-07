import { expect, test } from "vitest"
import { notFittedPaths, parseVariants } from "./variants"

const PRJ = [
	"[Design]",
	"Version=1.0",
	"",
	"[ProjectVariant2]",
	"Description=Lite",
	"VariationCount=1",
	"Variation1=Designator=U3|UniqueId=\\ABCDEFGH|Kind=1|AlternatePart=",
	"",
	"[ProjectVariant1]",
	"UniqueId=0F4A890B-1A94-4742-984C-06EB2591D9D2",
	"Description=Main",
	"VariationCount=3",
	"Variation1=Designator=R21_1|UniqueId=\\1OCQKBGNW\\BWCJKGGB|Kind=1|AlternatePart=",
	"Variation2=Designator=P5|UniqueId=\\SRADDCIC\\BMITZCDA|Kind=0|AlternatePart=",
	"Variation3=Designator=R1|UniqueId=\\MZGCZGPP\\NFBHISAR|Kind=1|AlternatePart==Value",
	"ParamVariation1=ParameterName=Comment|VariantValue==Value",
	"ParamDesignator1=R1",
	"",
	"[GeneratedDocument1]",
	"Variation9=Designator=X|UniqueId=\\NOTAVARIANT|Kind=1",
].join("\r\n")

test("variants in the project's order, with the parts each leaves off", () => {
	expect(parseVariants(PRJ)).toEqual([
		{ name: "Main", notFitted: ["\\1OCQKBGNW\\BWCJKGGB", "\\MZGCZGPP\\NFBHISAR"] },
		{ name: "Lite", notFitted: ["\\ABCDEFGH"] },
	])
})

test("a project without variants has none", () => {
	expect(parseVariants("[Design]\r\nVersion=1.0\r\n")).toEqual([])
})

test("a variant without a description is named by its number", () => {
	expect(parseVariants("[ProjectVariant3]\r\nDescription=\r\n")[0]!.name).toBe("Variant 3")
})

test("notFittedPaths: the named variant's parts, upper-cased; none for [No Variations]", () => {
	const variants = [{ name: "Main", notFitted: ["\\1ocq\\Abc"] }]
	expect([...notFittedPaths(variants, "Main")]).toEqual(["\\1OCQ\\ABC"])
	expect(notFittedPaths(variants, null).size).toBe(0)
	expect(notFittedPaths(variants, "Gone").size).toBe(0)
})
