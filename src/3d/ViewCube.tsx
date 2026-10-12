// The view cube: a small see-through box in the corner turned as the board is, one face per side of the
// board. A click on a face turns the view to look straight at it; dragging the cube turns the board like
// dragging the board. On hover, arrows turn about one of the view's axes only: a click turns a quarter
// turn, a drag turns freely about just that axis. Drawn with CSS 3D transforms, updated after every
// frame the engine draws (no React render per frame).
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react"
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, RotateCcw, RotateCw } from "lucide-react"
import * as THREE from "three"
import { CUBE_FACES, type BoardEngine, type CubeFace, type ViewAxis } from "./engine"

const SIZE = 56 // px, the cube's edge
const SLOP = 4 // px a press may move and still be a click
const CUBE_DRAG = 2 // a drag on the cube turns the board this many times as fast as one on the board
const ARROW_PER_PX = (0.8 * Math.PI) / 180 // an arrow dragged
const FACES: { face: CubeFace; label: string }[] = [
	{ face: "top", label: "Top" },
	{ face: "bottom", label: "Bottom" },
	{ face: "front", label: "Front" },
	{ face: "back", label: "Back" },
	{ face: "left", label: "Left" },
	{ face: "right", label: "Right" },
]

// Each arrow: the view axis it turns about and which way a click turns (as the board goes when dragged
// in the arrow's direction; a positive turn about z rolls the board clockwise on screen).
type Arrow = { id: string; label: string; axis: ViewAxis; sign: 1 | -1; Icon: typeof ChevronUp }
const ARROWS: Arrow[] = [
	{ id: "up", label: "Turn up", axis: "x", sign: 1, Icon: ChevronUp },
	{ id: "down", label: "Turn down", axis: "x", sign: -1, Icon: ChevronDown },
	{ id: "left", label: "Turn left", axis: "y", sign: 1, Icon: ChevronLeft },
	{ id: "right", label: "Turn right", axis: "y", sign: -1, Icon: ChevronRight },
	{ id: "ccw", label: "Roll anticlockwise", axis: "z", sign: -1, Icon: RotateCcw },
	{ id: "cw", label: "Roll clockwise", axis: "z", sign: 1, Icon: RotateCw },
]

// A press that either clicks or drags: onDrag gets the movement since the last move once it has gone
// past the slop; onClick fires if it never did.
function usePressDrag() {
	const [dragging, setDragging] = useState(false)
	const start = (e: ReactPointerEvent, onDrag: (dx: number, dy: number) => void, onClick: () => void) => {
		if (e.button !== 0) return
		e.preventDefault()
		e.stopPropagation()
		const el = e.currentTarget as HTMLElement
		el.setPointerCapture(e.pointerId)
		const x0 = e.clientX, y0 = e.clientY
		let x = x0, y = y0, moved = false
		const move = (m: PointerEvent) => {
			if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < SLOP) return
			if (!moved) setDragging(true)
			moved = true
			onDrag(m.clientX - x, m.clientY - y)
			x = m.clientX
			y = m.clientY
		}
		const up = () => {
			el.removeEventListener("pointermove", move)
			el.removeEventListener("pointerup", up)
			el.removeEventListener("pointercancel", up)
			setDragging(false)
			if (!moved) onClick()
		}
		el.addEventListener("pointermove", move)
		el.addEventListener("pointerup", up)
		el.addEventListener("pointercancel", up)
	}
	return { dragging, start }
}

export function ViewCube({ engine }: { engine: BoardEngine }) {
	const faces = useRef<(HTMLButtonElement | null)[]>([])
	const { dragging, start } = usePressDrag()

	useEffect(() => {
		const inverse = new THREE.Quaternion()
		const v = new THREE.Vector3()
		// A board-space direction in the cube's CSS space (x right, y down, z towards the viewer).
		const css = (d: readonly number[]) => {
			v.set(d[0]!, d[1]!, d[2]!).applyQuaternion(inverse)
			return [v.x, -v.y, v.z] as const
		}
		const update = () => {
			inverse.copy(engine.getView().quaternion).invert()
			FACES.forEach(({ face }, i) => {
				const el = faces.current[i]
				if (!el) return
				const { right, up, back } = CUBE_FACES[face]
				const x = css(right), n = css(back)
				const y = css(up).map(c => -c) // the face's own y runs down its up axis
				const facing = n[2]
				const h = SIZE / 2
				el.style.transform = `matrix3d(${x[0]},${x[1]},${x[2]},0,${y[0]},${y[1]},${y[2]},0,${n[0]},${n[1]},${n[2]},0,${n[0] * h},${n[1] * h},${n[2] * h},1)`
				// Faces turned away show through faintly and take no clicks; faces seen at a slant are darker.
				el.dataset.side = facing > 0.01 ? "front" : "back"
				el.style.setProperty("--facing", String(Math.max(facing, 0)))
				el.dataset.facing = facing > 0.999 ? "true" : "false"
			})
		}
		update()
		return engine.onRender(update)
	}, [engine])

	// The cube dragged: the board turns about the mouse-turn pivot taken when the drag started.
	const dragCube = (e: ReactPointerEvent) => {
		const face = (e.target as Element).closest<HTMLElement>("[data-side='front']")?.dataset.face as CubeFace | undefined
		const pivot = engine.rotationPivot()
		start(
			e,
			(dx, dy) => engine.rotate(dx * CUBE_DRAG, dy * CUBE_DRAG, pivot),
			() => face && engine.showFace(face),
		)
	}
	const dragArrow = (e: ReactPointerEvent, a: Arrow) => {
		const pivot = engine.rotationPivot()
		start(
			e,
			// The board follows the mouse as when dragged, but only about the arrow's axis; a roll follows
			// the drag across (rightwards turns clockwise).
			(dx, dy) => engine.turnAbout(a.axis, (a.axis === "y" ? -dx : a.axis === "x" ? -dy : dx) * ARROW_PER_PX, pivot),
			() => engine.stepTurn(a.axis, (a.sign * Math.PI) / 2),
		)
	}

	return (
		<div className={`view-cube${dragging ? " dragging" : ""}`} role="group" aria-label="View cube" style={{ "--cube": `${SIZE}px` } as CSSProperties}>
			<div className="view-cube-box" onPointerDown={dragCube}>
				{FACES.map(({ face, label }, i) => (
					<button
						key={face}
						ref={el => {
							faces.current[i] = el
						}}
						className="view-cube-face"
						data-face={face}
						aria-label={`View from ${label.toLowerCase()}`}
						title={label}
						// Mouse clicks come through the drag handler; this is the keyboard's.
						onClick={e => e.detail === 0 && engine.showFace(face)}
					>
						{label}
					</button>
				))}
			</div>
			{ARROWS.map(a => (
				<button
					key={a.id}
					className="view-cube-arrow"
					data-arrow={a.id}
					aria-label={a.label}
					title={a.label}
					onPointerDown={e => dragArrow(e, a)}
					onClick={e => e.detail === 0 && engine.stepTurn(a.axis, (a.sign * Math.PI) / 2)}
				>
					<a.Icon size={14} strokeWidth={2.5} />
				</button>
			))}
		</div>
	)
}
