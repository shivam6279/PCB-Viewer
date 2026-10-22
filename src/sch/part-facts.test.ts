import { describe, expect, test } from "vitest"
import type { CompiledComponent } from "../model/compile"
import { partFacts } from "./part-facts"

const part = (parameters: { name: string; value: string }[], over: Partial<CompiledComponent> = {}): CompiledComponent => ({
	id: "a#1",
	instanceId: "a",
	i: 1,
	designator: "R5_ESC_2",
	logicalDesignator: "R5_ESC",
	comment: "10k",
	description: "Resistor",
	libReference: "RES",
	footprint: "0402",
	uniqueId: "X",
	uniquePath: "\\X",
	parameters,
	...over,
})

describe("partFacts", () => {
	test("key facts first by the names libraries use, then the other parameters with a value", () => {
		const facts = partFacts(
			part([
				{ name: "Tolerance", value: "1%" },
				{ name: "Supplier Part Number 1", value: "311-10.0KLRCT-ND" },
				{ name: "Manufacturer", value: "Yageo" },
				{ name: "Part Number", value: "RC0402FR-0710KL" },
				{ name: "Supplier 1", value: "Digi-Key" },
				{ name: "Value", value: "10k" },
				{ name: "Price", value: "" },
				{ name: "Power", value: "*" },
			]),
		)
		expect(facts.key).toEqual([
			{ label: "Part Number", value: "RC0402FR-0710KL" },
			{ label: "Manufacturer", value: "Yageo" },
			{ label: "Supplier", value: "Digi-Key" },
			{ label: "Supplier Part Number", value: "311-10.0KLRCT-ND" },
			{ label: "Footprint", value: "0402" },
			{ label: "Library Ref", value: "RES" },
		])
		expect(facts.other).toEqual([{ name: "Tolerance", value: "1%" }])
	})

	test("a value that differs from the comment is listed; MPN spellings count as the part number", () => {
		const facts = partFacts(part([{ name: "Value", value: "10k 1%" }, { name: "MPN", value: "ABC-1" }], { footprint: "", libReference: "" }))
		expect(facts.key).toEqual([
			{ label: "Value", value: "10k 1%" },
			{ label: "Part Number", value: "ABC-1" },
		])
	})

	test("component links become links, once each, and leave the parameter list", () => {
		const facts = partFacts(
			part([
				{ name: "ComponentLink1Description", value: "Datasheet" },
				{ name: "ComponentLink1URL", value: "https://example.com/ds.pdf" },
				{ name: "componentlink2description", value: "Datasheet" },
				{ name: "componentlink2url", value: "https://example.com/ds.pdf" },
				{ name: "ComponentLink3URL", value: "file://local" },
			]),
		)
		expect(facts.links).toEqual([{ text: "Datasheet", url: "https://example.com/ds.pdf" }])
		expect(facts.other).toEqual([])
	})
})
