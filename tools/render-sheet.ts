// Dev tool: render one sheet with the app's own renderer to PNG, for side-by-side review
// against a PDF export (see tools/pdf-page.py).
// Usage: npx tsx tools/render-sheet.ts <sheet.SchDoc> <out.png> [--prj project.PrjPcb] [--crop x0,y0,x1,y1] [--width px] [--channel U_ESC1:1]
// --crop takes fractions of the full drawing (0..1), e.g. --crop 0.7,0.8,1,1 for the title block corner.
import { readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
import { parseArgs } from "node:util"
import { Resvg } from "@resvg/resvg-js"
import { renderSheetSvg } from "../src/parse/altium"

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { prj: { type: "string" }, crop: { type: "string" }, width: { type: "string", default: "2000" }, channel: { type: "string" } },
})
const [sheet, out] = positionals
if (!sheet || !out) throw new Error("usage: render-sheet <sheet.SchDoc> <out.png> [--prj p] [--crop x0,y0,x1,y1]")

let svg = renderSheetSvg(new Uint8Array(readFileSync(sheet)), {
	documentName: basename(sheet),
	projectBytes: values.prj ? new Uint8Array(readFileSync(values.prj)) : null,
	projectName: values.prj ? basename(values.prj) : null,
	// --channel U_ESC1:1 draws the sheet as that REPEAT channel
	channel: values.channel ? { name: values.channel.split(":")[0]!, index: Number(values.channel.split(":")[1]) } : null,
})
writeFileSync(out.replace(/\.png$/, ".svg"), svg)

// Frame the paper itself (not the renderer's margin) so crops line up with PDF pages.
const paper = /<g data-record="SheetBorder"[^>]*><rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg)
const [px, py, pw, ph] = paper ? paper.slice(1).map(Number) as [number, number, number, number] : [0, 0, 1, 1]
const [x0, y0, x1, y1] = (values.crop ?? "0,0,1,1").split(",").map(Number) as [number, number, number, number]
const [cw, ch] = [pw * (x1 - x0), ph * (y1 - y0)]
svg = svg
	.replace(/viewBox="[^"]+"/, `viewBox="${px + pw * x0} ${py + ph * y0} ${cw} ${ch}"`)
	.replace(/ width="\d+" height="\d+"/, ` width="${cw}" height="${ch}"`)
const png = new Resvg(svg, { fitTo: { mode: "width", value: Number(values.width) }, background: "#c8c8c8" }).render().asPng()
writeFileSync(out, png)
console.log(out)
