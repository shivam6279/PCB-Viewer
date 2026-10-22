// The schematic PDF export's settings. Net colours are remembered in this browser; every export
// starts physical.
export interface SchPdfOptions {
	netColors: boolean
	// Physical ("pages"): a page per sheet instance, every net and part. Logical ("grouped"): a page per
	// schematic document; one placed several times notes its instances and how each renames
	// designators and net labels.
	channels: "pages" | "grouped"
}

export const SCH_PDF_OPTIONS_KEY = "pcbv.schPdfOptions"
export const DEFAULT_SCH_PDF_OPTIONS: SchPdfOptions = { netColors: true, channels: "pages" }

export function storedSchPdfOptions(): SchPdfOptions {
	try {
		const saved = JSON.parse(localStorage.getItem(SCH_PDF_OPTIONS_KEY) ?? "null") as Partial<SchPdfOptions> | null
		return {
			netColors: typeof saved?.netColors === "boolean" ? saved.netColors : DEFAULT_SCH_PDF_OPTIONS.netColors,
			channels: "pages",
		}
	} catch {
		return DEFAULT_SCH_PDF_OPTIONS
	}
}

export function storeSchPdfOptions(options: SchPdfOptions) {
	try {
		localStorage.setItem(SCH_PDF_OPTIONS_KEY, JSON.stringify({ netColors: options.netColors }))
	} catch {
		// storage blocked: the choice lasts this visit only
	}
}
