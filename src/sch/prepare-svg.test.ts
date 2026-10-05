// @vitest-environment jsdom
import { expect, test } from "vitest"
import { prepareSheetSvg } from "./prepare-svg"

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="670" viewBox="0 0 1819 1219" onload="alert(1)">
	<rect width="100%" height="100%" fill="#fffcf8"/>
	<script>alert(2)</script>
	<foreignObject><div>x</div></foreignObject>
	<a href="javascript:alert(3)"><text>link</text></a>
	<g data-record="Wire" onclick="alert(4)"><line x1="0" y1="0" x2="10" y2="10"/></g>
</svg>`

test("strips script, event handlers, foreign content and the full-bleed background", () => {
	const { markup, viewBox } = prepareSheetSvg(SVG)
	expect(viewBox).toEqual({ x: 0, y: 0, w: 1819, h: 1219 })
	for (const bad of ["<script", "onload", "onclick", "foreignObject", "javascript:", 'width="100%"']) expect(markup).not.toContain(bad)
	expect(markup).toContain('data-record="Wire"')
	expect(markup).not.toMatch(/<svg[^>]*\swidth="1000"/)
})

test("rejects markup that is not an SVG", () => {
	expect(() => prepareSheetSvg("<html></html>")).toThrow()
})
