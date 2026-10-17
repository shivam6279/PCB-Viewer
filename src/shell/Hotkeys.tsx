import { Settings, X } from "lucide-react"
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Backdrop } from "./Backdrop"
import type { ViewTab } from "../app/store"

interface Hotkey {
	keys: string
	does: string
}

// What each view answers to: keys, and the mouse where it does more than click to select. Kept beside
// the handlers' behaviour: change one, change the other.
const COMMON: Hotkey[] = [
	{ keys: "1 – 4", does: "Switch to SCH, PCB, 3D, BOM" },
	{ keys: "Ctrl+F", does: "Search parts, nets and sheets" },
]

const VIEWS: Record<ViewTab, Hotkey[]> = {
	sch: [
		{ keys: "Wheel", does: "Zoom" },
		{ keys: "Drag", does: "Pan" },
	],
	pcb: [
		{ keys: "Wheel", does: "Zoom" },
		{ keys: "Drag", does: "Pan" },
		{ keys: "+ / −", does: "Next / previous layer" },
		{ keys: "Ctrl+Shift+Wheel", does: "Step through the layers" },
		{ keys: "Shift+S", does: "Layer mode: all, highlight current, current only" },
		{ keys: "F", does: "Mirror: view from the bottom" },
		{ keys: "Hold Shift", does: "Outline the net under the cursor" },
		{ keys: "Double-click", does: "Select a track's whole net" },
		{ keys: "Right-click", does: "List what is under the cursor" },
		{ keys: "Shift+Tab", does: "Step through what is under the last click" },
		{ keys: "M", does: "Ruler on / off" },
		{ keys: "R", does: "Ruler: radius / diameter, or back to distance" },
		{ keys: "Space", does: "Ruler: next kind (distance, X, Y; radius, diameter)" },
		{ keys: "Hold Ctrl", does: "Ruler: no snapping" },
		{ keys: "Delete", does: "Remove the selected measurement" },
		{ keys: "Esc", does: "Clear the selection" },
	],
	"3d": [
		{ keys: "Drag", does: "Rotate" },
		{ keys: "Right-drag", does: "Pan" },
		{ keys: "Wheel", does: "Zoom" },
		{ keys: "F", does: "Flip the board over at the cursor" },
		{ keys: "Z", does: "Hide / show part bodies" },
		{ keys: "Shift+S", does: "Layer mode: all, highlight current, current only" },
		{ keys: "Ctrl+Shift+Wheel", does: "Step through the layers" },
		{ keys: "Hold Shift", does: "Light up the net of the pad under the cursor" },
		{ keys: "Double-click", does: "Select the net of a track or pin" },
		{ keys: "Shift+Double-click", does: "Add a net to those highlighted, or take it off" },
		{ keys: "M", does: "Ruler on / off" },
		{ keys: "R", does: "Ruler: radius / diameter, or back to distance" },
		{ keys: "Space", does: "Ruler: next kind (distance, X, Y; radius, diameter)" },
		{ keys: "Hold Ctrl", does: "Ruler: no snapping" },
		{ keys: "Delete", does: "Remove the selected measurement" },
		{ keys: "Esc", does: "Clear the selection" },
	],
	bom: [],
}

const NAMES: Record<ViewTab, string> = { sch: "Schematic", pcb: "PCB", "3d": "3D", bom: "BOM" }

// The doc bar's gear: the hotkeys of the view shown, in a window over the page.
export function HotkeysButton({ tab }: { tab: ViewTab }) {
	const [open, setOpen] = useState(false)
	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [open])

	return (
		<>
			<button className={`docbar-tool${open ? " on" : ""}`} aria-label="Hotkeys" aria-expanded={open} onClick={() => setOpen(!open)}>
				<Settings size={16} />
			</button>
			{open &&
				createPortal(
					<Backdrop onClose={() => setOpen(false)}>
						<div className="stackup-dialog hotkeys-dialog" role="dialog" aria-label="Hotkeys">
							<div className="stackup-head">
								<div className="stackup-title">Hotkeys · {NAMES[tab]}</div>
								<span className="grow" />
								<button className="icon" aria-label="Close" onClick={() => setOpen(false)}>
									<X size={16} />
								</button>
							</div>
							<dl className="hotkeys-list">
								{[...VIEWS[tab], ...COMMON].map(h => (
									<div key={h.keys + h.does} className="hotkeys-row">
										<dt>{h.keys}</dt>
										<dd>{h.does}</dd>
									</div>
								))}
							</dl>
						</div>
					</Backdrop>,
					document.body,
				)}
		</>
	)
}
