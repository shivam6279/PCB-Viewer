// Click menus in the PDF, for viewers that run PDF JavaScript (Acrobat, Reader; Chrome's viewer runs
// none): a part's link opens a menu of its details (picking a link line opens it), a net's a menu of
// the sheets it is on (picking one zooms to the net there, a named /FitR destination). The menus are
// app.popUpMenu calls from one document-level script; each link calls it by index.
//
// jsPDF writes only URI and GoTo links, so a link is written as a placeholder URI and turned into a
// JavaScript action in the finished file, at exactly the same length (the file's offsets stay right).

import type { jsPDF } from "jspdf"

// What a net's menu goes to on a sheet page: the view fitted to a rectangle.
export interface SheetSpot {
	label: string // "ESC_Power (U_Power1)"
	page: number // 1-based
	rect: [left: number, bottom: number, right: number, top: number] // pt, PDF space (up from the page's foot)
}

export interface PartMenu {
	title: string // "R5_ESC_2   10k"
	key: string[] // "Value: 10k", "Part Number: ..."
	more: string[] // every other parameter
	links: string[] // "Datasheet: https://..."
}

export interface NetMenu {
	title: string
	sheets: { label: string; dest: string }[] // dest: a named destination (addFitDests)
}

const PREFIX = "pcbv-js:"
const DIGITS = 12

// The URI a link carries until the file is finished: "pcbv-js:p000000000012".
export const placeholder = (kind: "p" | "n", index: number) => `${PREFIX}${kind}${String(index).padStart(DIGITS, "0")}`

// The document-level script: the menus' data and the two functions links call, P(doc, i) and N(doc, i).
// Plain ASCII without backslashes: the script sits in a PDF string, where a backslash is an escape.
export function menuScript(parts: PartMenu[], nets: NetMenu[]): string {
	// Printable ASCII but for the backslash and the quote (JSON would escape both); the rest as codes.
	const plain = (ch: string) => ch >= " " && ch <= "~" && ch !== "\\" && ch !== '"' && ch !== "&"
	const ascii = (s: string) => [...s].map(ch => (plain(ch) ? ch : `&#${ch.codePointAt(0)};`)).join("")
	const text = (s: string) => {
		// Characters outside ASCII are rebuilt at run time from their codes: no escapes needed here.
		const pieces = ascii(s).split(/&#(\d+);/)
		return pieces.map((p, k) => (k % 2 ? `String.fromCharCode(${p})` : JSON.stringify(p))).filter(p => p !== '""').join("+") || '""'
	}
	const list = (items: string[]) => `[${items.map(text).join(",")}]`
	const partMenus = parts.map(p => {
		const menu = [text(p.title), '"-"', ...p.key.map(text), ...(p.more.length ? [`[${text(`Parameters (${p.more.length})`)},${p.more.map(text).join(",")}]`] : []), ...p.links.map(text)]
		return `{m:[${menu.join(",")}]}`
	})
	const netMenus = nets.map(n => `{m:[${[text(n.title), '"-"', ...n.sheets.map(s => text(s.label))].join(",")}],d:${list(n.sheets.map(s => s.dest))},l:${list(n.sheets.map(s => s.label))}}`)
	return [
		`var PCBV_PARTS=[${partMenus.join(",\n")}];`,
		`var PCBV_NETS=[${netMenus.join(",\n")}];`,
		"function PCBV_OPEN(c){var at=c.indexOf(': http');if(at<0)at=c.indexOf(': ftp');if(at>=0)app.launchURL(c.substr(at+2),true);}",
		"function P(doc,i){var c=app.popUpMenu.apply(app,PCBV_PARTS[i].m);if(c)PCBV_OPEN(c);}",
		"function N(doc,i){var n=PCBV_NETS[i];var c=app.popUpMenu.apply(app,n.m);if(!c)return;for(var k=0;k<n.l.length;k++)if(n.l[k]==c){doc.gotoNamedDest(n.d[k]);return;}}",
	].join("\n")
}

// Named destinations that fit the view to a rectangle on a page, for the menus to go to: written
// into the catalog's /Dests as the file is finished (jsPDF has no API for them).
export function addFitDests(pdf: jsPDF, dests: { name: string; page: number; rect: [number, number, number, number] }[]) {
	const internal = pdf.internal as unknown as {
		events: { subscribe(event: string, handler: () => void): void }
		newObject(): number
		out(line: string): void
		getPageInfo(page: number): { objId: number }
	}
	let object: number | undefined
	internal.events.subscribe("postPutResources", () => {
		object = internal.newObject()
		internal.out("<<")
		for (const d of dests) internal.out(`/${d.name} [${internal.getPageInfo(d.page).objId} 0 R /FitR ${d.rect.map(v => v.toFixed(1)).join(" ")}]`)
		internal.out(">>")
		internal.out("endobj")
	})
	internal.events.subscribe("putCatalog", () => {
		if (object !== undefined) internal.out(`/Dests ${object} 0 R`)
	})
}

// Turns each placeholder link into the JavaScript action calling its menu, byte for byte in place.
export function patchMenuLinks(file: string): string {
	return file.replace(/\/S \/URI \/URI \(pcbv-js:([pn])(\d+)\)/g, (whole, kind: string, digits: string) => {
		const call = `${kind === "p" ? "P" : "N"}(this,${Number(digits)});`
		const action = `/S /JavaScript /JS (${call}`
		if (action.length + 1 > whole.length) throw new Error("menu link too long to patch in place")
		return `${action.padEnd(whole.length - 1, " ")})`
	})
}
