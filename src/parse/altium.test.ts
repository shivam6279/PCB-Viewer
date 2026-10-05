import { expect, test } from "vitest"
import { decodeText, parseNetColors, parseProjectFile, parseSheetLinks } from "./altium"

const PRJ = [
	"[Design]",
	"Version=1.0",
	"ChannelDesignatorFormatString=$Component_$ChannelIndex",
	"",
	"[Document1]",
	"DocumentPath=Top.SchDoc",
	"",
	"[Document2]",
	"DocumentPath=Sub\\Board.PcbDoc",
	"",
	"[Parameter1]",
	"Name=ProjectTitle",
	"Value=Motor µController",
	"",
].join("\r\n")

function utf8(s: string) {
	return new TextEncoder().encode(s)
}

function cp1252(s: string) {
	// Every character used in these tests is in Latin-1, which maps 1:1 onto Windows-1252 here.
	return Uint8Array.from([...s].map(c => c.charCodeAt(0)))
}

test.each([
	["UTF-8 with BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(PRJ)])],
	["UTF-8 without BOM", utf8(PRJ)],
	["Windows-1252", cp1252(PRJ)],
])("parseProjectFile decodes %s", (_label, bytes) => {
	const p = parseProjectFile(bytes)
	expect(p.documentPaths).toEqual(["Top.SchDoc", "Sub\\Board.PcbDoc"])
	expect(p.parameters.ProjectTitle).toBe("Motor µController")
	expect(p.channelDesignatorFormat).toBe("$Component_$ChannelIndex")
})

test("channel designator format defaults to Altium's default", () => {
	expect(parseProjectFile(utf8("[Design]\r\nVersion=1.0\r\n")).channelDesignatorFormat).toBe("$Component_$RoomName")
})

test("decodeText strips a UTF-8 BOM", () => {
	expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe("A")
})

test("parseSheetLinks rejects bytes that are not a schematic", () => {
	expect(() => parseSheetLinks(utf8("hello"))).toThrow()
})

test("parseNetColors reads the project's net colours ($00BBGGRR) keyed by lower-cased net name", () => {
	const text = "[NetColors]\r\nNet1=NetName=12V|NetColor=$000083FD\r\nNet2=NetName=3V3_IMU|NetColor=$00FF6633\r\n"
	expect(parseNetColors(text)).toEqual({ "12v": "#fd8300", "3v3_imu": "#3366ff" })
	expect(parseNetColors("[Design]\r\n")).toEqual({})
})

test("parseNetColors understands Delphi colour names like clYellow", () => {
	expect(parseNetColors("Net20=NetName=GND|NetColor=clYellow\r\nNet21=NetName=X|NetColor=clNavy\r\n")).toEqual({ gnd: "#ffff00", x: "#000080" })
})
