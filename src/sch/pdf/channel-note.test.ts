import { describe, expect, test } from "vitest"
import { wildcard } from "./channel-note"

describe("a logical page's names: what instances share, and the part each names its own way", () => {
	test("a varying suffix", () => {
		expect(wildcard(["R1_CAN0", "R1_CAN1", "R1_CAN2"])).toEqual({ prefix: "R1_CAN", suffix: "", parts: ["0", "1", "2"] })
		expect(wildcard(["C25_ESC_1", "C25_ESC_2", "C25_ESC_10"])).toEqual({ prefix: "C25_ESC_", suffix: "", parts: ["1", "2", "10"] })
	})

	test("a varying middle keeps the shared end", () => {
		expect(wildcard(["CH1_VSNS", "CH2_VSNS"])).toEqual({ prefix: "CH", suffix: "_VSNS", parts: ["1", "2"] })
	})

	test("the same everywhere (a net that leaves the sheet): no wildcard", () => {
		expect(wildcard(["GND", "GND"])).toBeNull()
		expect(wildcard(["GND"])).toBeNull()
	})

	test("a negation marker stays with its character", () => {
		// A\ is a negated A: the marker stays in the shared part with it.
		expect(wildcard(["A\\1", "A\\2"])).toEqual({ prefix: "A\\", suffix: "", parts: ["1", "2"] })
		// 1\ is a negated 1: the marker goes with the part that varies.
		expect(wildcard(["X1\\", "X2\\"])).toEqual({ prefix: "X", suffix: "", parts: ["1\\", "2\\"] })
	})
})
