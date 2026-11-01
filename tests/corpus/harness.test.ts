import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { CORPUS, hasCorpus } from "./env"
import { renderSheetSvg } from "../../src/parse/altium"
import { projectData } from "./project-data"

const DIR = join(CORPUS, "Cubli/Main Board/STM32")
const render = (sheet: string) =>
	renderSheetSvg(new Uint8Array(readFileSync(join(DIR, sheet))), { documentName: sheet, projectBytes: null, projectName: null })

describe.skipIf(!hasCorpus)("signal harnesses from the Additional stream", () => {
	test("ESC_MCU draws its three harness connectors with their entries and type labels", () => {
		const svg = render("ESC_MCU.SchDoc")
		expect(svg.match(/<g data-record="215">/g)).toHaveLength(3)
		for (const label of [">I2C<", ">ENC<", ">SPI<", ">SDA<", ">SCL<"]) expect(svg).toContain(label)
	})

	test("Top draws its harness wire", () => {
		expect(render("Top.SchDoc").match(/<g data-record="218">/g)).toHaveLength(1)
	})
})

describe.skipIf(!hasCorpus)("a harness connector with its brace on the right (PnP ENET)", () => {
	test("its entries join the wires on their left and carry the nets up to the MCU sheet", async () => {
		const { compiled } = await projectData(join(CORPUS, "PnP/PnP"), "PnP.PrjPcb")
		for (const name of ["ENET_MDC", "ENET_MDIO", "RMII_PHY_TO_MAC_CLK"]) {
			const nets = compiled.nets.filter(n => n.netName === name)
			expect(nets, name).toHaveLength(1)
			expect(new Set(nets[0]!.occurrences.map(o => o.instanceId)), name).toEqual(new Set(["Top.SchDoc/MCU", "Top.SchDoc/ENET"]))
		}
		expect(compiled.nets.filter(n => n.netName.startsWith("Harness."))).toEqual([])
	}, 120000)
})
