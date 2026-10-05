import type { GhProject } from "./discovery"

// The home screen's project tree: repo > folders > projects, as the repo lays them out. A folder whose
// only content is one project becomes that project's row (labelled with the folder name), so
// "Cubli/Charger/Charger.PrjPcb" reads Cubli > Charger rather than Cubli > Charger > Charger.
export type TreeNode =
	| { kind: "folder"; key: string; label: string; children: TreeNode[] }
	| { kind: "project"; key: string; label: string; project: GhProject }

type Folder = Extract<TreeNode, { kind: "folder" }>

const byLabel = (a: TreeNode, b: TreeNode) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" })

export function buildProjectTree(projects: GhProject[]): Folder[] {
	const repos = new Map<string, Folder>()
	for (const p of projects) {
		const repoKey = `${p.owner}/${p.repo}`
		let dir = repos.get(repoKey)
		if (!dir) {
			dir = { kind: "folder", key: repoKey, label: p.repo, children: [] }
			repos.set(repoKey, dir)
		}
		for (const part of p.prjPath.split("/").slice(0, -1)) dir = childFolder(dir, part)
		dir.children.push({ kind: "project", key: `${repoKey}/${p.prjPath}`, label: p.name, project: p })
	}
	const out = [...repos.values()].map(r => ({ ...r, children: tidy(r.children) }))
	return out.sort(byLabel)
}

function childFolder(dir: Folder, name: string): Folder {
	const key = `${dir.key}/${name}`
	const found = dir.children.find((c): c is Folder => c.kind === "folder" && c.key === key)
	if (found) return found
	const made: Folder = { kind: "folder", key, label: name, children: [] }
	dir.children.push(made)
	return made
}

function tidy(nodes: TreeNode[]): TreeNode[] {
	// As on GitHub, folders come before files; a folder folded into its project still counts as one.
	const folders: TreeNode[] = []
	const files: TreeNode[] = []
	for (const n of nodes) {
		if (n.kind !== "folder") {
			files.push(n)
			continue
		}
		// Only a project file directly inside folds the folder, so folding never cascades upwards.
		const only = n.children.length === 1 ? n.children[0]! : null
		folders.push(only?.kind === "project" ? { ...only, label: n.label } : { ...n, children: tidy(n.children) })
	}
	return [...folders.sort(byLabel), ...files.sort(byLabel)]
}

// Keeps nodes whose label (or project name / path) matches, with the folders leading to them; a
// matching folder keeps everything under it.
export function filterTree<T extends TreeNode>(nodes: T[], query: string): T[] {
	const q = query.trim().toLowerCase()
	if (!q) return nodes
	const out: T[] = []
	for (const n of nodes) {
		if (n.kind === "project") {
			if (`${n.label} ${n.project.name} ${n.project.prjPath}`.toLowerCase().includes(q)) out.push(n)
		} else if (n.label.toLowerCase().includes(q)) out.push(n)
		else {
			const children = filterTree(n.children, q)
			if (children.length) out.push({ ...n, children })
		}
	}
	return out
}

// Keys of the folders above a node, outermost first.
export function ancestorsOf(nodes: TreeNode[], key: string, trail: string[] = []): string[] | null {
	for (const n of nodes) {
		if (n.key === key) return trail
		if (n.kind === "folder") {
			const found = ancestorsOf(n.children, key, [...trail, n.key])
			if (found) return found
		}
	}
	return null
}

export const projectKey = (p: { owner: string; repo: string; prjPath: string }) => `${p.owner}/${p.repo}/${p.prjPath}`
