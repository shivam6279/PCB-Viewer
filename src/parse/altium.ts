// Thin wrappers that turn altiumts objects into plain, structured-clone-able data.
// Runs both in the parse worker and in Node tests.
import { AltiumSchDoc, parseAltiumCompoundFile, parseAltiumFile, parseAltiumPrjPcb, parseAltiumSchDoc, type AltiumRecord } from "altiumts"
import { serializeAltiumSheetToSvg } from "../sch/render/serialize-altium-sheet-to-svg"

export interface ProjectFile {
	documentPaths: string[]
	parameters: Record<string, string>
	channelDesignatorFormat: string
}

export interface SheetLink {
	fileName: string
	designator: string
}

export function decodeText(bytes: Uint8Array): string {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3))
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
	} catch {
		return new TextDecoder("windows-1252").decode(bytes)
	}
}

export function parseProjectFile(bytes: Uint8Array): ProjectFile {
	const text = decodeText(bytes)
	const project = parseAltiumPrjPcb(text)

	// [ParameterN] sections flatten into Name=/Value= pairs.
	const parameters: Record<string, string> = {}
	let pending: string | undefined
	for (const { key, value } of project.projectParameters) {
		if (key === "Name") pending = value
		else if (key === "Value" && pending !== undefined) {
			parameters[pending] = value
			pending = undefined
		}
	}

	const format = /^ChannelDesignatorFormatString=(.*)$/m.exec(text)?.[1]?.trim()
	return {
		documentPaths: project.documents.map(d => d.path),
		parameters,
		channelDesignatorFormat: format || "$Component_$RoomName",
	}
}

export function parseSheetLinks(bytes: Uint8Array): SheetLink[] {
	return parseSchDoc(bytes).sheetLinks.map(l => ({ fileName: l.fileName ?? "", designator: l.name ?? "" }))
}

export interface SheetRenderOptions {
	documentName: string
	projectBytes: Uint8Array | null
	projectName: string | null
	// The REPEAT channel this instance of the sheet is drawn for (designators get the channel suffix).
	channel?: { index: number; name: string } | null
}

// The project file supplies the parameters that fill title-block strings like =Title, and net colours.
export function renderSheetSvg(bytes: Uint8Array, options: SheetRenderOptions): string {
	const projectText = options.projectBytes ? decodeText(options.projectBytes) : null
	return serializeAltiumSheetToSvg(parseSchDoc(bytes), {
		documentName: options.documentName,
		project: projectText !== null ? parseAltiumPrjPcb(projectText) : undefined,
		projectName: options.projectName ?? undefined,
		netColors: projectText !== null ? parseNetColors(projectText) : undefined,
		additionalRecords: parseAdditionalRecords(bytes),
		channel: options.channel
			? {
					...options.channel,
					designatorFormat:
						/^ChannelDesignatorFormatString=(.*)$/m.exec(projectText ?? "")?.[1]?.trim() || "$Component_$RoomName",
				}
			: undefined,
		currentDate: new Date().toLocaleDateString(),
		currentTime: new Date().toLocaleTimeString(),
	})
}

// Signal harness objects live in a second record stream ("Additional") that altiumts doesn't read.
// It is framed like FileHeader: a little-endian length (low 24 bits) before each "|KEY=VALUE..." record,
// the first record being a HEADER. Re-parsing it as an ASCII SchDoc gives typed records.
export function parseAdditionalRecords(bytes: Uint8Array): AltiumRecord[] {
	const stream = parseAltiumCompoundFile(bytes).streams.find(s => s.path.length === 1 && s.path[0] === "Additional")
	if (!stream) return []
	const data = stream.content
	const lines: string[] = []
	const decoder = new TextDecoder("windows-1252")
	for (let offset = 0; offset + 4 <= data.byteLength; ) {
		const length = (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)) >>> 0
		offset += 4
		if (length === 0 || offset + length > data.byteLength) break
		let payload = data.subarray(offset, offset + length)
		if (payload[payload.byteLength - 1] === 0) payload = payload.subarray(0, -1)
		const text = decoder.decode(payload)
		lines.push(text.startsWith("|") ? text : `|${text}`)
		offset += length
	}
	if (lines.length < 2) return []
	return parseAltiumSchDoc(lines.join("\r\n")).records.filter(r => r.recordKind !== undefined)
}

// Delphi's named TColor constants, which Altium writes for standard colours.
const DELPHI_COLORS: Record<string, string> = {
	clblack: "#000000", clmaroon: "#800000", clgreen: "#008000", clolive: "#808000", clnavy: "#000080",
	clpurple: "#800080", clteal: "#008080", clgray: "#808080", clsilver: "#c0c0c0", clred: "#ff0000",
	cllime: "#00ff00", clyellow: "#ffff00", clblue: "#0000ff", clfuchsia: "#ff00ff", claqua: "#00ffff",
	clwhite: "#ffffff", clmoneygreen: "#c0dcc0", clskyblue: "#a6caf0", clcream: "#fffbf0", clmedgray: "#a0a0a4",
}

// Net colours are stored in the project as "NetName=<name>|NetColor=$00BBGGRR" or a Delphi name (clYellow).
export function parseNetColors(projectText: string): Record<string, string> {
	const colors: Record<string, string> = {}
	for (const m of projectText.matchAll(/NetName=([^|\r\n]+)\|NetColor=([^|\r\n]+)/g)) {
		const value = m[2]!.trim()
		const hex = /^\$([0-9A-Fa-f]{8})$/.exec(value)?.[1]
		const css = hex ? `#${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}`.toLowerCase() : DELPHI_COLORS[value.toLowerCase()]
		if (css) colors[m[1]!.trim().toLowerCase()] = css
	}
	return colors
}

export function parseSchDoc(bytes: Uint8Array): AltiumSchDoc {
	const { document } = parseAltiumFile(bytes)
	if (!(document instanceof AltiumSchDoc)) throw new Error("Not a schematic document")
	return document
}
