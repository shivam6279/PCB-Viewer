import { useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

export interface PickRow {
	key: string
	kind: string
	label: string
	detail: string
	current: boolean
	section?: string // a heading above this row
}

// The right-click menu over the board: everything under the cursor (and the nets there), so what a part
// covers can still be picked. On the page body (fixed): each view is its own compositor layer, which
// would trap it underneath. x, y are client coordinates.
export function PickMenu({ x, y, rows, onPick, onHover, onClose }: {
	x: number
	y: number
	rows: PickRow[]
	onPick(key: string): void
	onHover(key: string | null): void
	onClose(): void
}) {
	const ref = useRef<HTMLDivElement>(null)
	const [pos, setPos] = useState({ x, y })

	// Before paint, so a press right after the menu opens already closes it.
	useLayoutEffect(() => {
		// Esc closes the menu and nothing else (the board's Esc would clear the selection).
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return
			e.stopImmediatePropagation()
			onClose()
		}
		// A press outside closes it; on the board that press does nothing more (no pick, no pan).
		const onDown = (e: PointerEvent) => {
			const target = e.target as Element | null
			if (ref.current?.contains(target)) return
			onClose()
			if (target?.closest?.(".pcb-view")) {
				e.stopPropagation()
				e.preventDefault()
			}
		}
		window.addEventListener("keydown", onKey, true)
		window.addEventListener("pointerdown", onDown, true)
		return () => {
			window.removeEventListener("keydown", onKey, true)
			window.removeEventListener("pointerdown", onDown, true)
		}
	}, [onClose])

	// Keep the menu inside the window.
	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		setPos({
			x: Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4)),
			y: Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4)),
		})
	}, [x, y, rows])

	return createPortal(
		<div
			ref={ref}
			className="port-menu pick-menu"
			role="menu"
			aria-label="Objects here"
			style={{ left: pos.x, top: pos.y }}
			onPointerDown={e => e.stopPropagation()}
			onPointerUp={e => e.stopPropagation()}
			onPointerMove={e => e.stopPropagation()}
			onPointerLeave={() => onHover(null)}
			onWheel={e => e.stopPropagation()}
			onContextMenu={e => e.preventDefault()}
		>
			{rows.map(r => [
				r.section && (
					<div key={`${r.key}:section`} className="pick-menu-section">
						{r.section}
					</div>
				),
				<div
					key={r.key}
					role="menuitem"
					className={`pick-menu-row${r.current ? " current" : ""}`}
					onPointerEnter={() => onHover(r.key)}
					onClick={() => onPick(r.key)}
				>
					<span className="pick-menu-kind">{r.kind}</span>
					<span className="pick-menu-label">{r.label}</span>
					{r.detail && <span className="pick-menu-detail">{r.detail}</span>}
				</div>,
			])}
		</div>,
		document.body,
	)
}
