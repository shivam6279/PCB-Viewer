import { expect, test } from "vitest"
import { searchItems, type SearchItem } from "./search"

const comp = (label: string, detail = ""): SearchItem => ({ kind: "component", id: label, label, detail, also: [] })
const net = (label: string, also: string[] = []): SearchItem => ({ kind: "net", id: 0, label, detail: "", also })

const items = [comp("R10", "4.7k"), comp("R1", "10k"), comp("U1", "STM32G474"), net("I2C_SDA"), net("SDA_OUT"), net("VBUS", ["USB_5V"]), comp("C2", "SDA cap")]
const labels = (q: string) => searchItems(items, q).map(i => i.label)

test("ranks the exact name, then its start, then a word inside it, then anywhere, then comments and aliases", () => {
	expect(labels("r1")).toEqual(["R1", "R10"])
	expect(labels("sda")).toEqual(["SDA_OUT", "I2C_SDA", "C2"])
	expect(labels("stm32")).toEqual(["U1"])
	expect(labels("usb")).toEqual(["VBUS"])
})

test("an empty query finds nothing; case is ignored", () => {
	expect(labels("  ")).toEqual([])
	expect(labels("I2C")).toEqual(["I2C_SDA"])
})
