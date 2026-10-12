import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Search } from "lucide-react"
import { searchItems, type SearchItem } from "./search"

const KIND_LABEL = { component: "Part", net: "Net", sheet: "Sheet" }

// The project search popup under the top bar: type, arrow through the hits, Enter or click to show
// one. It lives on the page body, like the port menu, so no view's compositor layer traps it.
export function SearchPalette({ items, onPick, onClose }: { items: SearchItem[]; onPick(item: SearchItem): void; onClose(): void }) {
	const ref = useRef<HTMLDivElement>(null)
	const list = useRef<HTMLDivElement>(null)
	const [query, setQuery] = useState("")
	const [active, setActive] = useState(0)
	const hits = useMemo(() => searchItems(items, query), [items, query])

	useEffect(() => setActive(0), [query])
	useEffect(() => {
		list.current?.querySelector(".search-hit.active")?.scrollIntoView({ block: "nearest" })
	}, [active])
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) onClose()
		}
		window.addEventListener("pointerdown", onDown, true)
		return () => window.removeEventListener("pointerdown", onDown, true)
	}, [onClose])

	const pick = (item: SearchItem | undefined) => {
		if (!item) return
		onPick(item)
		onClose()
	}
	const onKey = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") return onClose()
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault()
			if (hits.length) setActive(a => (a + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length)
		} else if (e.key === "Enter") {
			e.preventDefault()
			pick(hits[active])
		}
	}

	return createPortal(
		<div className="search-palette" ref={ref} role="dialog" aria-label="Search project">
			<label className="topbar-search">
				<Search size={16} />
				<input autoFocus aria-label="Search parts, nets and sheets" placeholder="Search parts, nets and sheets" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKey} />
			</label>
			{query.trim() && (
				<div className="search-hits" ref={list} role="listbox">
					{hits.length === 0 && <div className="search-empty">No matches</div>}
					{hits.map((item, k) => (
						<div
							key={`${item.kind}:${item.id}`}
							role="option"
							aria-selected={k === active}
							className={`search-hit${k === active ? " active" : ""}`}
							onPointerMove={() => setActive(k)}
							onClick={() => pick(item)}
						>
							<span className="search-kind">{KIND_LABEL[item.kind]}</span>
							<span className="search-label">{item.label}</span>
							{item.detail && <span className="search-detail">{item.detail}</span>}
						</div>
					))}
				</div>
			)}
		</div>,
		document.body,
	)
}
