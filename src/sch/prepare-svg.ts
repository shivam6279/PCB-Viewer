import type { ViewBox } from "./viewport"

const FORBIDDEN = ["script", "foreignObject", "iframe", "object", "embed"]

// Sheet SVG is generated from the user's own file, but it is still injected into the page,
// so anything executable is removed before it reaches the DOM.
export function prepareSheetSvg(svgText: string): { markup: string; viewBox: ViewBox } {
	const doc = new DOMParser().parseFromString(svgText, "image/svg+xml")
	const svg = doc.documentElement
	if (svg.nodeName !== "svg" || doc.getElementsByTagName("parsererror").length > 0) throw new Error("Renderer did not produce an SVG")

	for (const tag of FORBIDDEN) for (const el of [...svg.getElementsByTagName(tag)]) el.remove()
	for (const el of [svg, ...svg.getElementsByTagName("*")])
		for (const attr of [...el.attributes]) {
			const name = attr.name.toLowerCase()
			if (name.startsWith("on") || ((name === "href" || name === "xlink:href") && /^\s*javascript:/i.test(attr.value)))
				el.removeAttribute(attr.name)
		}

	// The renderer paints its whole canvas off-white; the viewer's own grey canvas shows around the paper instead.
	for (const el of [...svg.children])
		if (el.nodeName === "rect" && el.getAttribute("width") === "100%" && el.getAttribute("height") === "100%") el.remove()

	const [x = 0, y = 0, w = 0, h = 0] = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number)
	svg.removeAttribute("width")
	svg.removeAttribute("height")
	return { markup: new XMLSerializer().serializeToString(svg), viewBox: { x, y, w, h } }
}
