// A schematic record group's drawing (its SVG markup) as what it is relative to where it is: every x and
// y coordinate (x, x1, cx, y…, polyline points, absolute path points, translate / rotate centres /
// matrix offsets) taken from its first point; sizes, angles, relative path steps and text as they are.
// Two groups the same but moved by (dx, dy) then have the same key. Pure.
import type { Movable } from "./moves"

type Kind = "x" | "y" | "r"

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi
const X_ATTRS = new Set(["x", "x1", "x2", "cx"])
const Y_ATTRS = new Set(["y", "y1", "y2", "cy"])

// The kinds of the numbers in an attribute value, in order.
function kinds(name: string, value: string): Kind[] {
	const count = value.match(NUM)?.length ?? 0
	if (X_ATTRS.has(name)) return Array(count).fill("x")
	if (Y_ATTRS.has(name)) return Array(count).fill("y")
	if (name === "points") return Array.from({ length: count }, (_, i) => (i % 2 ? "y" : "x"))
	if (name === "d") {
		const out: Kind[] = []
		let cmd = ""
		let k = 0
		for (const t of value.match(/[a-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []) {
			if (/^[a-z]$/i.test(t)) {
				cmd = t
				k = 0
				continue
			}
			const abs = cmd === cmd.toUpperCase()
			const c = cmd.toUpperCase()
			let kind: Kind = "r"
			if (abs) {
				if (c === "H") kind = "x"
				else if (c === "V") kind = "y"
				else if (c === "A") kind = k % 7 === 5 ? "x" : k % 7 === 6 ? "y" : "r"
				else kind = k % 2 ? "y" : "x"
			}
			out.push(kind)
			k++
		}
		return out
	}
	if (name === "transform") {
		const out: Kind[] = []
		for (const [, fn, args] of value.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
			const n = args!.match(NUM)?.length ?? 0
			for (let i = 0; i < n; i++) {
				if (fn === "translate") out.push(i === 0 ? "x" : "y")
				else if (fn === "rotate") out.push(i === 1 ? "x" : i === 2 ? "y" : "r")
				else if (fn === "matrix") out.push(i === 4 ? "x" : i === 5 ? "y" : "r")
				else out.push("r")
			}
		}
		return out
	}
	return Array(count).fill("r")
}

const ATTR = /(\s)([\w:-]+)="([^"]*)"/g
const round = (v: number) => Math.round(v * 100) / 100

export function schMovable(markup: string): Movable | null {
	// First pass: where its points are.
	const xs: number[] = [], ys: number[] = []
	for (const [, , name, value] of markup.matchAll(ATTR)) {
		const ks = kinds(name!, value!)
		const nums = value!.match(NUM) ?? []
		nums.forEach((n, i) => {
			if (ks[i] === "x") xs.push(Number(n))
			else if (ks[i] === "y") ys.push(Number(n))
		})
	}
	if (!xs.length || !ys.length) return null
	const x0 = xs[0]!, y0 = ys[0]!
	// Second pass: the markup with every point taken from the first.
	const key = markup.replace(ATTR, (_all, space: string, name: string, value: string) => {
		const ks = kinds(name, value)
		let i = 0
		const v = value.replace(NUM, n => {
			const k = ks[i++]
			const num = Number(n)
			return k === "x" ? `x${round(num - x0)}` : k === "y" ? `y${round(num - y0)}` : String(round(num))
		})
		return `${space}${name}="${v}"`
	})
	return { key, x: x0, y: y0, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }
}
