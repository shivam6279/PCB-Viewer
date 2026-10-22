// The STEP export's settings: its own module, so the doc bar's dialog and the store can use them without
// loading the export (and the 3D geometry code it needs).
export interface StepExportOptions {
	onePart: boolean // everything one part (off: an assembly of the board's layers and every part's model)
	parts: boolean // every part's model
	copper: boolean // the outer copper layers
	copperUnderMask: boolean // with the mask: also the copper it covers (off: only what its openings show)
	platedHoles: boolean // the plating in drilled plated holes
	mask: boolean // the solder masks, open over the pads
	maskOneFace: boolean // each mask one face (off: cut into tiles, quicker for CAD to read, the seams drawn as lines)
	silkscreen: boolean
	viaHoles: boolean // drill the vias (pad holes are always drilled)
	quality: StepQuality // how finely the copper, mask and silkscreen's curves are cut
}

export type StepQuality = "draft" | "standard" | "fine"
export const STEP_QUALITIES: StepQuality[] = ["draft", "standard", "fine"]
// The furthest a chord may stray from its arc, per quality (mils). Drill holes and part models are
// exact whatever the quality.
export const QUALITY_TOLERANCE: Record<StepQuality, number> = { draft: 1, standard: 0.2, fine: 0.05 }

export const DEFAULT_STEP_OPTIONS: StepExportOptions = { onePart: true, parts: true, copper: true, copperUnderMask: false, platedHoles: true, mask: true, maskOneFace: true, silkscreen: true, viaHoles: false, quality: "fine" }

// The dialog's settings, remembered in this browser (the last ones exported with).
export const STEP_OPTIONS_KEY = "view3d.stepExport"

export function storedStepOptions(): StepExportOptions {
	try {
		const saved = JSON.parse(localStorage.getItem(STEP_OPTIONS_KEY) ?? "null")
		const o = { ...DEFAULT_STEP_OPTIONS, ...(saved && typeof saved === "object" ? saved : {}) }
		return STEP_QUALITIES.includes(o.quality) ? o : { ...o, quality: DEFAULT_STEP_OPTIONS.quality }
	} catch {
		return { ...DEFAULT_STEP_OPTIONS }
	}
}

type Toggle = Exclude<keyof StepExportOptions, "quality">

// Whether a setting matters with the others as they are: the copper the mask covers only with both, the
// mask's one face only with the mask.
export const choiceApplies = (key: Toggle, o: StepExportOptions) => (key === "copperUnderMask" ? o.copper && o.mask : key === "maskOneFace" ? o.mask : true)

// The settings one click from these: each setting that applies flipped, and the quality either side.
// (The mask's one face looks the same in a preview: not among them.)
export function neighbourOptions(o: StepExportOptions): StepExportOptions[] {
	const out: StepExportOptions[] = []
	for (const key of ["parts", "copper", "copperUnderMask", "platedHoles", "mask", "silkscreen", "viaHoles"] as const) if (choiceApplies(key, o)) out.push({ ...o, [key]: !o[key] })
	const q = STEP_QUALITIES.indexOf(o.quality)
	for (const k of [q - 1, q + 1]) if (k >= 0 && k < STEP_QUALITIES.length) out.push({ ...o, quality: STEP_QUALITIES[k]! })
	return out
}

// The export dialog's preview pictures: one per combination of the settings, rendered once ahead (by
// scripts/render-step-previews.mjs) and shipped in public/step-previews. Settings that make the same
// file share one: the copper under the mask only counts with both copper and mask. The mask as one face
// or tiles looks the same (the preview board's is never tiled).
export function stepPreviewName(o: StepExportOptions): string {
	const bit = (b: boolean) => (b ? 1 : 0)
	return `p${bit(o.parts)}c${bit(o.copper)}u${bit(o.copper && o.mask && o.copperUnderMask)}h${bit(o.platedHoles)}m${bit(o.mask)}s${bit(o.silkscreen)}v${bit(o.viaHoles)}-${o.quality}`
}

// Every combination of the settings, one per preview picture.
export function everyStepOption(): StepExportOptions[] {
	const out = new Map<string, StepExportOptions>()
	for (let bits = 0; bits < 128; bits++) {
		const b = (i: number) => (bits & (1 << i)) !== 0
		for (const quality of STEP_QUALITIES) {
			const o = { onePart: true, parts: b(0), copper: b(1), copperUnderMask: b(1) && b(4) && b(2), platedHoles: b(3), mask: b(4), maskOneFace: true, silkscreen: b(5), viaHoles: b(6), quality }
			out.set(stepPreviewName(o), o)
		}
	}
	return [...out.values()]
}

// What each setting adds to the file (bytes), measured on the board one setting at a time (see
// estimateStep): summed for the settings chosen, an estimate of the file's size.
export interface StepEstimate {
	base: number // the header, the board solid and the assembly
	parts: number
	copper: number // with no mask: all of it
	mask: number // with no copper: no openings but the holes
	copperAndMask: number // the copper in the mask's openings, and the mask
	allCopperAndMask: number // all the copper, and the mask
	platedHoles: number // the plating of the pads' holes
	viaBarrels: number // and of the vias', when they are drilled
	silkscreen: number
	viaHoles: number // the vias drilled through the board solid
}

export function estimateBytes(e: StepEstimate, o: StepExportOptions): number {
	let bytes = e.base
	if (o.parts) bytes += e.parts
	if (o.copper && o.mask) bytes += o.copperUnderMask ? e.allCopperAndMask : e.copperAndMask
	else if (o.copper) bytes += e.copper
	else if (o.mask) bytes += e.mask
	if (o.platedHoles) bytes += e.platedHoles
	if (o.silkscreen) bytes += e.silkscreen
	// Drilled vias cut the board and, about as much again, the copper.
	if (o.viaHoles) bytes += e.viaHoles * (o.copper ? 2 : 1) + (o.platedHoles ? e.viaBarrels : 0)
	return bytes
}
