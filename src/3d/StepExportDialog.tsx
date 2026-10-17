import { Backdrop } from "../shell/Backdrop"
import { X } from "lucide-react"
import { useEffect, useState } from "react"
import { useAppStore } from "../app/store"
import { choiceApplies, estimateBytes, STEP_OPTIONS_KEY, stepPreviewName, STEP_QUALITIES, storedStepOptions, type StepEstimate, type StepExportOptions, type StepQuality } from "./step-export/options"

type Toggle = Exclude<keyof StepExportOptions, "quality">

// Each setting (copperUnderMask only applies with both copper and mask: see choiceApplies).
const CHOICES: { key: Toggle; label: string; indent?: boolean }[] = [
	{ key: "parts", label: "Parts" },
	{ key: "copper", label: "Copper" },
	{ key: "copperUnderMask", label: "Copper under the solder mask", indent: true },
	{ key: "platedHoles", label: "Plated holes" },
	{ key: "mask", label: "Solder mask" },
	{ key: "silkscreen", label: "Silkscreen" },
	{ key: "viaHoles", label: "Drill via holes" },
]

const QUALITY_NAMES: Record<StepQuality, string> = { draft: "Draft", standard: "Standard", fine: "Fine" }

const formatSize = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`)

// The STEP export's settings, remembered in this browser, with a preview of what they put in the file
// and an estimate of its size.
export function StepExportDialog({ onExport, onClose }: { onExport(options: StepExportOptions): void; onClose(): void }) {
	const [options, setOptions] = useState<StepExportOptions>(storedStepOptions)
	const estimator = useAppStore(s => s.stepEstimator)
	const [estimates, setEstimates] = useState<Partial<Record<StepQuality, StepEstimate>>>({})
	const estimate = estimates[options.quality]
	// The preview: the sample board as these settings export it, a picture made ahead for each.
	const previewSrc = `${import.meta.env.BASE_URL}step-previews/${stepPreviewName(options)}.webp`
	const [shownSrc, setShownSrc] = useState<string | null>(null)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [onClose])
	useEffect(() => {
		if (!estimator || estimate) return
		let live = true
		const quality = options.quality
		estimator(quality)
			.then(e => live && setEstimates(prev => ({ ...prev, [quality]: e })))
			.catch(e => console.error("STEP size estimate failed", e))
		return () => {
			live = false
		}
	}, [estimator, estimate, options.quality])
	const exportNow = () => {
		try {
			localStorage.setItem(STEP_OPTIONS_KEY, JSON.stringify(options))
		} catch {
			// storage blocked: the choice lasts this visit only
		}
		onExport(options)
	}

	return (
		<Backdrop onClose={onClose}>
			<div className="stackup-dialog step-dialog" role="dialog" aria-label="Export STEP">
				<div className="stackup-head">
					<div className="stackup-title">Export STEP</div>
					<span className="grow" />
					<button className="icon" aria-label="Close" onClick={onClose}>
						<X size={16} />
					</button>
				</div>
				<div className="step-body">
					<div className="step-preview-frame" aria-busy={shownSrc !== previewSrc}>
						<img className="step-preview" src={previewSrc} alt="Preview of the export" onLoad={() => setShownSrc(previewSrc)} />
					</div>
					<div className="step-options">
						{CHOICES.map(c => (
							<label key={c.key} className={`step-option${c.indent ? " indent" : ""}`} aria-disabled={!choiceApplies(c.key, options)}>
								<input type="checkbox" checked={options[c.key]} disabled={!choiceApplies(c.key, options)} onChange={e => setOptions({ ...options, [c.key]: e.target.checked })} />
								<span className="step-option-label">{c.label}</span>
							</label>
						))}
						<label className="step-quality">
							<span className="step-option-label">Curve quality</span>
							<input
								type="range"
								min={0}
								max={STEP_QUALITIES.length - 1}
								step={1}
								value={STEP_QUALITIES.indexOf(options.quality)}
								aria-valuetext={QUALITY_NAMES[options.quality]}
								onChange={e => setOptions({ ...options, quality: STEP_QUALITIES[Number(e.target.value)]! })}
							/>
							<span className="step-quality-stops">
								{STEP_QUALITIES.map(q => (
									<span key={q} className={q === options.quality ? "on" : ""}>
										{QUALITY_NAMES[q]}
									</span>
								))}
							</span>
						</label>
					</div>
				</div>
				<div className="step-actions">
					<span className="step-size" role="status">
						{estimate ? `Estimated size: ${formatSize(estimateBytes(estimate, options))}` : "Estimating size…"}
					</span>
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
