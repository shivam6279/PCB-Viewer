import { X } from "lucide-react"
import { useEffect, useState } from "react"
import { Backdrop } from "../../shell/Backdrop"
import { storedSchPdfOptions, storeSchPdfOptions, type SchPdfOptions } from "./options"

// The schematic PDF's settings (net colours remembered; physical each time). Physical or logical shows only for a
// project with a sheet placed more than once.
export function SchPdfDialog({ hasChannels, onExport, onClose }: { hasChannels: boolean; onExport(options: SchPdfOptions): void; onClose(): void }) {
	const [options, setOptions] = useState<SchPdfOptions>(storedSchPdfOptions)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [onClose])
	const exportNow = () => {
		storeSchPdfOptions(options)
		onExport(options)
	}

	return (
		<Backdrop onClose={onClose}>
			<div className="stackup-dialog step-dialog sch-pdf-dialog" role="dialog" aria-label="Export PDF">
				<div className="stackup-head">
					<div className="stackup-title">Export PDF</div>
					<span className="grow" />
					<button className="icon" aria-label="Close" onClick={onClose}>
						<X size={16} />
					</button>
				</div>
				<div className="step-options sch-pdf-options">
					<label className="step-option">
						<input type="checkbox" checked={options.netColors} onChange={e => setOptions({ ...options, netColors: e.target.checked })} />
						<span className="step-option-label">Net colours</span>
					</label>
					{hasChannels && (
						<fieldset className="sch-pdf-choice">
							<legend>Sheets placed more than once (channels)</legend>
							<label className="step-option">
								<input type="radio" name="channels" checked={options.channels === "pages"} onChange={() => setOptions({ ...options, channels: "pages" })} />
								<span className="step-option-label">Physical: a page for every instance (every part and net)</span>
							</label>
							<label className="step-option">
								<input type="radio" name="channels" checked={options.channels === "grouped"} onChange={() => setOptions({ ...options, channels: "grouped" })} />
								<span className="step-option-label">Logical: a page per schematic document, noting its channels and the names each gives designators and net labels</span>
							</label>
						</fieldset>
					)}
				</div>
				<div className="step-actions">
					<span className="grow" />
					<button className="btn" onClick={onClose}>
						Cancel
					</button>
					<button className="btn primary" onClick={exportNow}>
						Export
					</button>
				</div>
			</div>
		</Backdrop>
	)
}
