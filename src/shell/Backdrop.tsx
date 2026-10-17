import { useEffect, useState, type ReactNode } from "react"

const GAP = 24

// Padding that leaves the canvas: the view area under the doc bar, less the inspector over its right.
function canvasPadding(): string | undefined {
	const area = document.querySelector(".main-body")?.getBoundingClientRect()
	if (!area) return undefined
	const inspector = document.querySelector(".main-body > .inspector")?.getBoundingClientRect()
	const right = inspector && inspector.width > 0 ? inspector.left : area.right
	return `${area.top + GAP}px ${window.innerWidth - right + GAP}px ${window.innerHeight - area.bottom + GAP}px ${area.left + GAP}px`
}

// The dimmed page under a dialog, which sits centred on the canvas. A press on it closes the dialog.
export function Backdrop({ onClose, children }: { onClose(): void; children: ReactNode }) {
	const [padding, setPadding] = useState(canvasPadding)
	useEffect(() => {
		const onResize = () => setPadding(canvasPadding())
		window.addEventListener("resize", onResize)
		return () => window.removeEventListener("resize", onResize)
	}, [])
	return (
		<div className="stackup-backdrop" style={{ padding }} onPointerDown={e => e.target === e.currentTarget && onClose()}>
			{children}
		</div>
	)
}
