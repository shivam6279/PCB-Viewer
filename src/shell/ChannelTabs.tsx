import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { channelOf, flattenHierarchy, type HierarchyNode } from "../model/hierarchy"
import { DocIcon } from "../app/tree-icons"

// The channels of a multi-channel sheet: one tab per place the shown sheet's file is used, along
// the bottom of the schematic. Nothing for a sheet used once. Too many to fit scroll sideways: by the
// arrows at either end, the wheel, or a drag of the scroll bar; the shown one is kept in view.
export function ChannelTabs({ hierarchy, sheet, onPick }: { hierarchy: HierarchyNode[]; sheet: HierarchyNode; onPick(id: string): void }) {
	const instances = sheet.docPath ? flattenHierarchy(hierarchy).filter(n => n.docPath === sheet.docPath) : []
	const strip = useRef<HTMLDivElement>(null)
	const [more, setMore] = useState({ left: false, right: false })
	const many = instances.length >= 2

	useEffect(() => {
		const el = strip.current
		if (!el) return
		const update = () => setMore({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 })
		const onWheel = (e: WheelEvent) => {
			if (el.scrollWidth <= el.clientWidth) return
			e.preventDefault()
			el.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
		}
		update()
		el.addEventListener("scroll", update)
		el.addEventListener("wheel", onWheel, { passive: false })
		const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
		resize?.observe(el)
		return () => {
			el.removeEventListener("scroll", update)
			el.removeEventListener("wheel", onWheel)
			resize?.disconnect()
		}
	}, [many])

	useEffect(() => {
		strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
	}, [sheet.id])

	if (!many) return null
	const step = (dir: number) => strip.current?.scrollBy({ left: dir * strip.current.clientWidth * 0.8, behavior: "smooth" })
	return (
		<div className="channel-tabs">
			<span className="channel-tabs-sheet" title={`${sheet.fileName} is one sheet placed ${instances.length} times`}>
				<span className="tree-icon-stack" aria-hidden>
					<DocIcon kind="sch" />
					<DocIcon kind="sch" />
				</span>
				{sheet.fileName}
				<span className="tree-channels">×{instances.length}</span>
			</span>
			{more.left && (
				<button className="channel-tabs-step" aria-label="Earlier channels" onClick={() => step(-1)}>
					<ChevronLeft size={16} />
				</button>
			)}
			<div className="channel-tabs-strip" ref={strip} role="tablist" aria-label="Channels">
				{instances.map((n, k) => (
					<button key={n.id} role="tab" className="channel-tab" aria-selected={n.id === sheet.id} data-sheet={n.id} onClick={() => onPick(n.id)}>
						<span className="tree-channel">CH {channelOf(hierarchy, n.id)?.index ?? k + 1}</span>
						{n.displayDesignator}
					</button>
				))}
			</div>
			{more.right && (
				<button className="channel-tabs-step" aria-label="Later channels" onClick={() => step(1)}>
					<ChevronRight size={16} />
				</button>
			)}
		</div>
	)
}
