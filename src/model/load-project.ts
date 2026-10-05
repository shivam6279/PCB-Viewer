import type { SheetLink } from "../parse/altium"
import type { Parser } from "../parse/parser"
import { basename, dirname, extname, joinPath, normalizePath, PathIndex, stripExt } from "../source/paths"
import { isInSkippedDir } from "../source/skip"
import type { ProjectSource } from "../source/types"
import { buildHierarchy, type HierarchyNode } from "./hierarchy"

export type DocKind = "sch" | "pcb" | "other"

export interface DocEntry {
	path: string
	name: string
	kind: DocKind
	exists: boolean
	error: string | null
}

export interface ProjectSummary {
	name: string
	prjPath: string | null
	parameters: Record<string, string>
	channelDesignatorFormat: string
	documents: DocEntry[]
	hierarchy: HierarchyNode[]
}

const DESIGN_EXTS = new Set([".schdoc", ".pcbdoc", ".pcbdwf", ".bomdoc", ".outjob", ".harness", ".schlib", ".pcblib", ".intlib"])

export function docKind(path: string): DocKind {
	const ext = extname(path)
	return ext === ".schdoc" ? "sch" : ext === ".pcbdoc" ? "pcb" : "other"
}

export async function findProjects(source: ProjectSource): Promise<string[]> {
	return (await source.list()).filter(p => extname(p) === ".prjpcb" && !isInSkippedDir(p)).sort()
}

export async function findLooseDocuments(source: ProjectSource): Promise<string[]> {
	return (await source.list()).filter(p => docKind(p) !== "other" && !isInSkippedDir(p)).sort()
}

export async function loadProject(source: ProjectSource, prjPath: string | null, parser: Parser): Promise<ProjectSummary> {
	const index = new PathIndex(await source.list())

	let name = source.name
	let parameters: Record<string, string> = {}
	let channelDesignatorFormat = "$Component_$RoomName"
	let baseDir = ""
	let rawPaths: string[]
	if (prjPath !== null) {
		const project = await parser.parseProjectFile(await source.read(prjPath))
		name = stripExt(prjPath)
		parameters = project.parameters
		channelDesignatorFormat = project.channelDesignatorFormat
		baseDir = dirname(prjPath)
		rawPaths = project.documentPaths
	} else rawPaths = await findLooseDocuments(source)

	const documents: DocEntry[] = []
	for (const raw of rawPaths) {
		if (!DESIGN_EXTS.has(extname(raw))) continue
		const joined = joinPath(baseDir, raw)
		const actual = joined === null ? undefined : index.get(joined)
		documents.push({
			path: actual ?? joined ?? normalizePath(raw.replace(/^(\.\.[\\/])+/, "")) ?? raw,
			name: basename(raw.replaceAll("\\", "/")),
			kind: docKind(raw),
			exists: actual !== undefined,
			error: null,
		})
	}

	const sheets = documents.filter(d => d.kind === "sch")
	const linksBySheet = new Map<string, SheetLink[]>()
	// Every sheet's bytes are requested up front (a remote source downloads them in parallel), then
	// parsed in order.
	const bytes = new Map(sheets.filter(d => d.exists).map(d => [d.path, source.read(d.path)] as const))
	for (const p of bytes.values()) p.catch(() => {}) // failures are reported per sheet below
	for (const doc of sheets) {
		if (!doc.exists) continue
		try {
			linksBySheet.set(doc.path, await parser.parseSheetLinks(await bytes.get(doc.path)!))
		} catch (e) {
			doc.error = e instanceof Error ? e.message : String(e)
		}
	}

	// Altium resolves a sheet symbol's file by name among the project's documents first.
	const sheetByName = new Map<string, string>()
	for (const doc of sheets) if (!sheetByName.has(doc.name.toLowerCase())) sheetByName.set(doc.name.toLowerCase(), doc.path)
	const resolve = (fileName: string, fromSheet: string): string | null => {
		const byName = sheetByName.get(basename(fileName.replaceAll("\\", "/")).toLowerCase())
		if (byName) return byName
		const joined = joinPath(dirname(fromSheet), fileName)
		return (joined && index.get(joined)) ?? null
	}

	const hierarchy = buildHierarchy({ sheets: sheets.map(d => d.path), linksBySheet, resolve })
	return { name, prjPath, parameters, channelDesignatorFormat, documents, hierarchy }
}
