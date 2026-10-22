import { describe, expect, test } from "vitest"
import { menuScript, patchMenuLinks, placeholder } from "./click-menus"

// The script as the viewer runs it, with app.popUpMenu answering as `pick` says.
function run(script: string, pick: (items: unknown[]) => string | null) {
	const shown: unknown[][] = []
	const opened: string[] = []
	const app = { popUpMenu: (...items: unknown[]) => (shown.push(items), pick(items)), launchURL: (url: string) => opened.push(url) }
	const doc = { pageNum: -1, dest: "", gotoNamedDest(name: string) { this.dest = name } }
	const { P, N } = new Function("app", `${script}\nreturn { P, N }`)(app) as { P(doc: object, i: number): void; N(doc: object, i: number): void }
	return { P: (i: number) => P(doc, i), N: (i: number) => N(doc, i), shown, opened, doc }
}

const part = {
	title: 'R5_ESC_2   10k "1%"',
	key: ["Value: 10k", "Part Number: RC0402\\FR"],
	more: ["Tolerance: ±1%"],
	links: ["Datasheet: https://example.com/a(b).pdf"],
}
const net = { title: "VBAT", sheets: [{ label: "Top (Top)", dest: "pcbv_n4_0" }] }
const script = menuScript([part], [net])

describe("click menus", () => {
	test("the script has no backslashes (a PDF string would eat them) and is plain ASCII", () => {
		expect(script).not.toContain("\\")
		expect(/^[\x09\x0a\x20-\x7e]*$/.test(script)).toBe(true)
	})

	test("a part's menu: title, key facts, the other parameters as a submenu, links", () => {
		const m = run(script, () => null)
		m.P(0)
		expect(m.shown[0]).toEqual(['R5_ESC_2   10k "1%"', "-", "Value: 10k", "Part Number: RC0402\\FR", ["Parameters (1)", "Tolerance: ±1%"], "Datasheet: https://example.com/a(b).pdf"])
	})

	test("picking a link line opens it; other lines do nothing", () => {
		const m = run(script, items => (m.shown.length === 1 ? (items[5] as string) : (items[2] as string)))
		m.P(0)
		m.P(0)
		expect(m.opened).toEqual(["https://example.com/a(b).pdf"])
		expect(m.doc.dest).toBe("")
	})

	test("a net's menu lists its sheets; picking one goes to its destination there (zoomed to the net)", () => {
		const m = run(script, items => items[2] as string)
		m.N(0)
		expect(m.shown[0]).toEqual(["VBAT", "-", "Top (Top)"])
		expect(m.doc.dest).toBe("pcbv_n4_0")
	})

	test("a placeholder link becomes a JavaScript action of exactly the same length", () => {
		const link = `<</Type /Annot /Subtype /Link /Rect [1 2 3 4] /Border [0 0 0] /A <</S /URI /URI (${placeholder("p", 1234)}) >>`
		const patched = patchMenuLinks(link)
		expect(patched).toHaveLength(link.length)
		expect(patched).toContain("/A <</S /JavaScript /JS (P(this,1234);")
		expect(patchMenuLinks(`/S /URI /URI (${placeholder("n", 7)})`)).toMatch(/^\/S \/JavaScript \/JS \(N\(this,7\); *\)$/)
	})
})
