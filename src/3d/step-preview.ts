// Renders the export dialog's preview pictures: the preview board exported with each combination of
// the settings (in its own worker), read back and drawn (renderStepPreview). Run once, ahead, by
// scripts/render-step-previews.mjs; the app only shows the pictures it made (public/step-previews).
import { wrap } from "comlink"
import type { PreviewWorkerApi } from "./step-export/preview.worker"
import { renderStepPreview } from "./step-preview-render"
import type { StepExportOptions } from "./step-export/options"

let worker: ReturnType<typeof wrap<PreviewWorkerApi>> | null = null

export async function renderPreview(options: StepExportOptions): Promise<string | null> {
	worker ??= wrap<PreviewWorkerApi>(new Worker(new URL("./step-export/preview.worker.ts", import.meta.url), { type: "module" }))
	return renderStepPreview(await worker.previewStep(options))
}
