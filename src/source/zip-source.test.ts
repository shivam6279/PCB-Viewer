import { expect, test } from "vitest"
import { strToU8, zipSync } from "fflate"
import { zipSource } from "./zip-source"
import { SourceFileNotFound } from "./types"

test("zipSource lists files (not directories) and reads them back", async () => {
	const zip = zipSync({
		"Wrapper/": new Uint8Array(),
		"Wrapper/Board.PrjPcb": strToU8("[Design]"),
		"Wrapper/sub/Top.SchDoc": strToU8("x"),
		"__MACOSX/Wrapper/._Board.PrjPcb": strToU8("junk"),
	})
	const src = zipSource("Board.zip", zip)
	expect(src.name).toBe("Board.zip")
	expect((await src.list()).sort()).toEqual(["Wrapper/Board.PrjPcb", "Wrapper/sub/Top.SchDoc"])
	expect(new TextDecoder().decode(await src.read("Wrapper/Board.PrjPcb"))).toBe("[Design]")
	await expect(src.read("nope")).rejects.toBeInstanceOf(SourceFileNotFound)
})

test("zipSource never unpacks Altium housekeeping folders", async () => {
	const zip = zipSync({
		"P/History/old.PrjPcb": strToU8("h"),
		"P/.git/config": strToU8("g"),
		"P/Project Outputs for P/x.GTL": strToU8("o"),
		"P/P.PrjPcb": strToU8("[Design]"),
	})
	expect(await zipSource("P.zip", zip).list()).toEqual(["P/P.PrjPcb"])
})
