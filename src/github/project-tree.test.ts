import { expect, test } from "vitest"
import type { GhProject } from "./discovery"
import { ancestorsOf, buildProjectTree, filterTree, type TreeNode } from "./project-tree"

const p = (prjPath: string, repo = "PCB"): GhProject => ({
	owner: "me",
	repo,
	branch: "master",
	prjPath,
	name: prjPath.split("/").pop()!.replace(/\.PrjPcb$/i, ""),
})

// name(kind) with children indented, for readable expectations.
function show(nodes: TreeNode[], depth = 0): string[] {
	return nodes.flatMap(n => [
		`${"  ".repeat(depth)}${n.label}${n.kind === "project" ? ` [${n.project.name}]` : "/"}`,
		...(n.kind === "folder" ? show(n.children, depth + 1) : []),
	])
}

test("nests projects by folder under their repo, folders first, numeric order", () => {
	const tree = buildProjectTree([
		p("Cubli/Main Board/STM32/Cubli.PrjPcb"),
		p("Cubli/Main Board/Rev2/Sensor.PrjPcb"),
		p("Cubli/Main Board/Rev10/Sensor.PrjPcb"),
		p("Cubli/Charger/Charger.PrjPcb"),
		p("LedFlex/LedFlex.PrjPcb"),
		p("Top.PrjPcb"),
		p("A/B.PrjPcb", "Other"),
	])
	expect(show(tree)).toEqual([
		"Other/",
		"  A [B]",
		"PCB/",
		"  Cubli/",
		"    Charger [Charger]",
		"    Main Board/",
		"      Rev2 [Sensor]",
		"      Rev10 [Sensor]",
		"      STM32 [Cubli]",
		"  LedFlex [LedFlex]",
		"  Top [Top]",
	])
})

test("a folder holding several projects keeps them as children", () => {
	const tree = buildProjectTree([p("Quad/Rev5/FC.PrjPcb"), p("Quad/Rev5/ESC.PrjPcb"), p("Quad/Rev5/Sub/X.PrjPcb")])
	expect(show(tree)).toEqual(["PCB/", "  Quad/", "    Rev5/", "      Sub [X]", "      ESC [ESC]", "      FC [FC]"])
})

test("filter keeps matches and the folders leading to them", () => {
	const tree = buildProjectTree([p("Cubli/Main Board/STM32/Cubli.PrjPcb"), p("Cubli/Charger/Charger.PrjPcb"), p("LedFlex/LedFlex.PrjPcb")])
	expect(show(filterTree(tree, "stm"))).toEqual(["PCB/", "  Cubli/", "    Main Board/", "      STM32 [Cubli]"])
	// a folder name matches too, with everything under it
	expect(show(filterTree(tree, "cubli"))).toEqual(["PCB/", "  Cubli/", "    Charger [Charger]", "    Main Board/", "      STM32 [Cubli]"])
	expect(filterTree(tree, "nothing")).toEqual([])
})

test("ancestors of a project, for expanding to it", () => {
	const tree = buildProjectTree([p("Cubli/Main Board/STM32/Cubli.PrjPcb")])
	const project = (tree[0]!.children[0] as Extract<TreeNode, { kind: "folder" }>).children[0] as Extract<TreeNode, { kind: "folder" }>
	expect(ancestorsOf(tree, project.children[0]!.key)).toEqual(["me/PCB", "me/PCB/Cubli", "me/PCB/Cubli/Main Board"])
})
