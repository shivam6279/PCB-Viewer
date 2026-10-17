import { ChevronDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"

// The doc bar's sheet picker: the sheet shown, its arrow beside it in one button, opening the list
// of sheets under it. Up/Down move through the list, Enter picks, Esc or a click elsewhere closes.
export function SheetPicker({ sheets, active, onPick }: { sheets: { id: string; label: string }[]; active: string | null; onPick(id: string): void }) {
	const [open, setOpen] = useState(false)
	const [hover, setHover] = useState(0)
	const root = useRef<HTMLDivElement>(null)
	const current = sheets.find(s => s.id === active) ?? sheets[0]

	useEffect(() => {
		if (!open) return
		setHover(Math.max(0, sheets.findIndex(s => s.id === active)))
		const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
		window.addEventListener("pointerdown", onDown, true)
		return () => window.removeEventListener("pointerdown", onDown, true)
	}, [open, sheets, active])

	const onKey = (e: React.KeyboardEvent) => {
		if (!open) {
			if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
				e.preventDefault()
				setOpen(true)
			}
			return
		}
		e.stopPropagation()
		if (e.key === "Escape") setOpen(false)
		else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault()
			setHover(h => (h + (e.key === "ArrowDown" ? 1 : sheets.length - 1)) % sheets.length)
		} else if (e.key === "Enter") {
			e.preventDefault()
			const s = sheets[hover]
			if (s) onPick(s.id)
			setOpen(false)
		}
	}

	return (
		<div className="sheet-picker" ref={root} onKeyDown={onKey}>
			<button className={`sheet-picker-button${open ? " on" : ""}`} aria-label="Sheet" data-sheet={current?.id ?? ""} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className="sheet-picker-label">{current?.label}</span>
				<ChevronDown size={14} />
			</button>
			{open && (
				<div className="sheet-picker-list" role="listbox" aria-label="Sheets">
					{sheets.map((s, i) => (
						<div
							key={s.id}
							role="option"
							aria-selected={s.id === current?.id}
							className={`sheet-picker-row${i === hover ? " hover" : ""}${s.id === current?.id ? " current" : ""}`}
							onPointerEnter={() => setHover(i)}
							onClick={() => {
								onPick(s.id)
								setOpen(false)
							}}
						>
							{s.label}
						</div>
					))}
				</div>
			)}
		</div>
	)
}
