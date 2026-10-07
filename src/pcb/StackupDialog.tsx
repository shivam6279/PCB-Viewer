import { X } from "lucide-react"
import { useEffect, useState } from "react"
import { stackupThickness, type StackupKind, type StackupLayer } from "./stackup"

type Unit = "mil" | "mm"
const UNIT_KEY = "pcb.stackup.unit"

const LABEL: Record<StackupKind, string> = {
	overlay: "Overlay",
	paste: "Paste",
	mask: "Solder Mask",
	signal: "Signal",
	plane: "Plane",
	prepreg: "Prepreg",
	core: "Core",
}

function storedUnit(): Unit {
	try {
		return localStorage.getItem(UNIT_KEY) === "mm" ? "mm" : "mil"
	} catch {
		return "mil"
	}
}

const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)))
const length = (mils: number, unit: Unit) => (unit === "mil" ? `${trim(mils, 3)} mil` : `${trim(mils * 0.0254, 4)} mm`)
const weight = (oz: number) => (oz === 0.5 ? "½ oz" : oz === 0.25 ? "¼ oz" : `${trim(oz, 2)} oz`)

// The board's layer stack: one row per layer, top to bottom. The first column draws each layer as a
// band in its material's colour, so the column reads as a cross-section of the board.
export function StackupDialog({ stackup, colors, onClose }: { stackup: StackupLayer[]; colors: Map<string, string>; onClose(): void }) {
	const [unit, setUnit] = useState<Unit>(storedUnit)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [onClose])
	const chooseUnit = (u: Unit) => {
		setUnit(u)
		try {
			localStorage.setItem(UNIT_KEY, u)
		} catch {
			// storage blocked: the choice lasts this visit only
		}
	}

	const copperCount = stackup.filter(l => l.kind === "signal" || l.kind === "plane").length
	let copperIndex = 0
	return (
		<div className="stackup-backdrop" onPointerDown={e => e.target === e.currentTarget && onClose()}>
			<div className="stackup-dialog" role="dialog" aria-label="Layer stack">
				<div className="stackup-head">
					<div>
						<div className="stackup-title">Layer Stack</div>
						<div className="stackup-summary">
							{copperCount} copper layers · board thickness <b>{length(stackupThickness(stackup), unit)}</b>
						</div>
					</div>
					<span className="grow" />
					<div className="stackup-units" role="radiogroup" aria-label="Units">
						{(["mil", "mm"] as const).map(u => (
							<button key={u} role="radio" aria-checked={unit === u} onClick={() => chooseUnit(u)}>
								{u}
							</button>
						))}
					</div>
					<button className="icon" aria-label="Close" onClick={onClose}>
						<X size={16} />
					</button>
				</div>
				<div className="stackup-scroll">
					<table className="stackup-table">
						<thead>
							<tr>
								<th className="stackup-graphic-head" aria-label="Cross-section" />
								<th className="num">#</th>
								<th>Name</th>
								<th>Material</th>
								<th>Type</th>
								<th className="num">Weight</th>
								<th className="num">Thickness</th>
								<th className="num">Dk</th>
							</tr>
						</thead>
						<tbody>
							{stackup.map((l, i) => {
								const copper = l.kind === "signal" || l.kind === "plane"
								return (
									<tr key={i} data-kind={l.kind}>
										<td className="stackup-graphic">
											<span className={`stackup-band ${l.kind}`} />
										</td>
										<td className="num">{copper ? ++copperIndex : ""}</td>
										<td>
											{copper && l.key && <span className="stackup-swatch" style={{ background: colors.get(l.key) ?? "#888" }} />}
											{l.name}
										</td>
										<td>{l.material}</td>
										<td>{LABEL[l.kind]}</td>
										<td className="num">{l.weight !== null ? weight(l.weight) : ""}</td>
										<td className="num">{l.thickness > 0 ? length(l.thickness, unit) : ""}</td>
										<td className="num">{l.dk !== null ? trim(l.dk, 2) : ""}</td>
									</tr>
								)
							})}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	)
}
