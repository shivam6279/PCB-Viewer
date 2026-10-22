import { useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { MenuNode } from "./interaction"
import { DocIcon } from "../app/tree-icons"

export interface PopupArea {
	left: number
	top: number
	width: number
	height: number
}

// A popup at the cursor over the schematic, kept inside the view; Escape or a press outside closes it.
// It lives on the page body (fixed, over the inspector): each tab's view is its own compositor layer,
// which would otherwise trap it underneath. x, y are relative to the view's area.
export function SchPopup({ x, y, area, className, label, onClose, children }: {
	x: number
	y: number
	area: PopupArea
	className: string
	label: string
	onClose(): void
	children: ReactNode
}) {
	const ref = useRef<HTMLDivElement>(null)
	const [pos, setPos] = useState({ x, y })

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) onClose()
		}
		window.addEventListener("keydown", onKey)
		window.addEventListener("pointerdown", onDown, true)
		return () => {
			window.removeEventListener("keydown", onKey)
			window.removeEventListener("pointerdown", onDown, true)
		}
	}, [onClose])

	// Keep it inside the view, also as it grows (a branch opened).
	useEffect(() => {
		const el = ref.current
		if (!el) return
		const fit = () =>
			setPos({
				x: Math.max(0, Math.min(x, area.width - el.offsetWidth - 4)),
				y: Math.max(0, Math.min(y, area.height - el.offsetHeight - 4)),
			})
		fit()
		const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit)
		resize?.observe(el)
		return () => resize?.disconnect()
	}, [x, y, area.width, area.height])

	return createPortal(
		<div
			ref={ref}
			className={`sch-popup ${className}`}
			role="menu"
			aria-label={label}
			style={{ left: area.left + pos.x, top: area.top + pos.y }}
			onPointerDown={e => e.stopPropagation()}
			onPointerUp={e => e.stopPropagation()}
			onPointerMove={e => e.stopPropagation()}
			onWheel={e => e.stopPropagation()}
			onContextMenu={e => e.preventDefault()}
		>
			{children}
		</div>,
		document.body,
	)
}

// The port / sheet entry / net popup: the sheet instances the net reaches, as a tree, at the cursor.
export function PortMenu({ x, y, area, title, items, onPick, onClose }: {
	x: number
	y: number
	area: PopupArea
	title?: string
	items: MenuNode[]
	onPick(instanceId: string): void
	onClose(): void
}) {
	const [open, setOpen] = useState<Set<string>>(() => {
		const keys = new Set<string>()
		const walk = (n: MenuNode) => {
			if (n.expanded) keys.add(n.key)
			n.children.forEach(walk)
		}
		items.forEach(walk)
		return keys
	})

	const toggle = (key: string) =>
		setOpen(prev => {
			const next = new Set(prev)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})

	const rows = (nodes: MenuNode[], depth: number): ReactNode[] =>
		nodes.flatMap(n => {
			const expanded = open.has(n.key)
			const pickable = n.instanceId !== null && n.reached
			return [
				<div
					key={n.key}
					role="menuitem"
					className={`port-menu-row${n.current ? " current" : ""}${pickable ? "" : " inert"}`}
					style={{ paddingLeft: 6 + depth * 16 }}
					aria-disabled={pickable ? undefined : "true"}
					onClick={() => (pickable ? onPick(n.instanceId!) : n.children.length > 0 && toggle(n.key))}
				>
					{n.children.length > 0 ? (
						<button
							className="port-menu-chevron"
							aria-label={`${expanded ? "Collapse" : "Expand"} ${n.label}`}
							onClick={e => {
								e.stopPropagation()
								toggle(n.key)
							}}
						>
							{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
						</button>
					) : (
						<span className="port-menu-chevron" />
					)}
					<DocIcon kind="sch" />
					<span className="port-menu-label">{n.label}</span>
				</div>,
				...(expanded ? rows(n.children, depth + 1) : []),
			]
		})

	return (
		<SchPopup x={x} y={y} area={area} className="port-menu" label={title ? `Sheets with ${title}` : "Sheets"} onClose={onClose}>
			{title && <div className="sch-popup-title">{title}</div>}
			{rows(items, 0)}
		</SchPopup>
	)
}
