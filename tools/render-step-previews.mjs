// Renders the STEP export dialog's preview pictures, once: the preview board (src/3d/step-export/
// sample-board.ts) exported with every combination of the dialog's settings, read back and drawn, each
// written to public/step-previews/<name>.webp. Re-run after changing the preview board or the exporter.
//
//   npm run dev                       (in another terminal)
//   node tools/render-step-previews.mjs [http://localhost:5173/]
import { mkdirSync, writeFileSync } from "node:fs"
import { chromium } from "@playwright/test"

const url = process.argv[2] ?? "http://localhost:5173/"
const out = new URL("../public/step-previews/", import.meta.url)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: "chrome" })
const page = await browser.newPage()
await page.goto(url)
const names = await page.evaluate(async () => {
	const { everyStepOption, stepPreviewName } = await import("/src/3d/step-export/options.ts")
	return everyStepOption().map(stepPreviewName)
})
for (const [i, name] of names.entries()) {
	const dataUrl = await page.evaluate(async name => {
		const { everyStepOption, stepPreviewName } = await import("/src/3d/step-export/options.ts")
		const { renderPreview } = await import("/src/3d/step-preview.ts")
		return renderPreview(everyStepOption().find(o => stepPreviewName(o) === name))
	}, name)
	if (!dataUrl?.startsWith("data:image/webp")) throw new Error(`${name}: no picture`)
	writeFileSync(new URL(`${name}.webp`, out), Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"))
	process.stdout.write(`\r${i + 1}/${names.length}`)
}
console.log()
await browser.close()
