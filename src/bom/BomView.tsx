import { Download, Search } from "lucide-react"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { usePane, usePaneData, usePaneSelection } from "../app/pane"
import { useAppStore } from "../app/store"
import { bomCsv, type BomLine, type BomRef } from "./bom"

type Column = { id: keyof BomLine | "designators"; label: string; className?: string; text(l: BomLine): string }

const COLUMNS: Column[] = [
	{ id: "line", label: "#", className: "num", text: l => String(l.line) },
	{ id: "designators", label: "Designator", className: "designators", text: l => l.designators.map(d => d.name).join(", ") },
	{ id: "quantity", label: "Qty", className: "num", text: l => String(l.quantity) },
	{ id: "comment", label: "Comment", text: l => l.comment },
	{ id: "description", label: "Description", className: "wide", text: l => l.description },
	{ id: "footprint", label: "Footprint", text: l => l.footprint },
	{ id: "manufacturer", label: "Manufacturer", text: l => l.manufacturer },
	{ id: "mpn", label: "Manufacturer Part Number", text: l => l.mpn },
	{ id: "supplier", label: "Supplier", text: l => l.supplier },
	{ id: "supplierPartNo", label: "Supplier Part Number", text: l => l.supplierPartNo },
]

const sameRef = (a: BomRef, sel: ReturnType<typeof usePaneSelection>) =>
	sel !== null && sel.kind === a.kind && (a.kind === "component" ? (sel as { id: string }).id === a.id : (sel as { index: number }).index === a.index)

// The BOM tab: one row per line, designators clickable (selects the part, as a click on it anywhere).
export function BomView({ projectName }: { projectName: string }) {
	const pane = usePane()
	const data = usePaneData()
	const selection = usePaneSelection()
	const [filter, setFilter] = useState("")
	const bom = data.status === "ready" ? data.data.bom : null
	const scroller = useRef<HTMLDivElement>(null)
	// A part selected anywhere: its line scrolled into view.
	useEffect(() => {
		scroller.current?.querySelector(".bom-designator.on")?.closest("tr")?.scrollIntoView({ block: "nearest" })
	}, [selection])

	const lines = useMemo(() => {
		if (!bom) return []
		const q = filter.trim().toLowerCase()
		if (!q) return bom.lines
		return bom.lines.filter(l => COLUMNS.some(c => c.text(l).toLowerCase().includes(q)))
	}, [bom, filter])
	// Columns nothing in the BOM fills stay out.
	const columns = useMemo(() => COLUMNS.filter(c => c.id === "line" || c.id === "designators" || c.id === "quantity" || bom?.lines.some(l => c.text(l) !== "")), [bom])

	if (data.status === "loading") return <div className="view-message">Reading the project…</div>
	if (!bom) return <div className="view-message">This project has no parts</div>

	const source = bom.source === "board" ? "the board" : "the schematics"
	const matched = bom.lines.filter(l => l.fromBomDoc).length
	const download = () => {
		const url = URL.createObjectURL(new Blob([bomCsv(bom)], { type: "text/csv" }))
		const a = document.createElement("a")
		a.href = url
		a.download = `${projectName} BOM.csv`
		document.body.append(a)
		a.click()
		a.remove()
		setTimeout(() => URL.revokeObjectURL(url), 1000)
	}

	return (
		// The inspector (open with a selection, outside a comparison) covers the right of the view.
		<div className={`bom-view${selection && !pane.diff ? " with-inspector" : ""}`} data-source={bom.source}>
			<div className="bom-bar">
				<div className="bom-summary">
					<span className="bom-counts">
						{bom.lines.length} lines · {bom.parts} parts
					</span>
					<span className="bom-source">
						{bom.bomDoc ? (
							<>
								Parts from {source}, items from <b>{bom.bomDoc}</b> ({matched} of {bom.lines.length} lines found there)
							</>
						) : (
							<>Parts from {source}</>
						)}
					</span>
				</div>
				<label className="bom-filter">
					<Search size={14} />
					<input type="search" placeholder="Filter" aria-label="Filter BOM" value={filter} onChange={e => setFilter(e.target.value)} onKeyDown={e => e.stopPropagation()} />
				</label>
				<button className="bom-export" onClick={download}>
					<Download size={14} />
					CSV
				</button>
			</div>
			<div className="bom-scroll" ref={scroller}>
				<table className="bom-table">
					<thead>
						<tr>
							{columns.map(c => (
								<th key={c.id} className={c.className}>
									{c.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{lines.map(l => (
							<tr key={l.line} className={l.fromBomDoc || !bom.bomDoc ? "" : "not-in-doc"}>
								{columns.map(c => (
									<td key={c.id} className={c.className}>
										{c.id === "designators"
											? l.designators.map((d, i) => (
													// A designator and its comma never split across lines; the space between items is
													// where a line may break.
													<Fragment key={i}>
														<span className="bom-designator-item">
															<button
																className={`bom-designator${sameRef(d.ref, selection) ? " on" : ""}`}
																disabled={pane.diff}
																onClick={() => useAppStore.getState().select(d.ref)}
															>
																{d.name}
															</button>
															{i < l.designators.length - 1 && ","}
														</span>{" "}
													</Fragment>
												))
											: c.text(l)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
				{lines.length === 0 && <div className="bom-empty">No line matches “{filter}”</div>}
			</div>
		</div>
	)
}
