// World space for the 3D view: mm, centred on the board's bounds, z = 0 at the board's top surface.
import type { PcbScene } from "../pcb/scene"
import type { Board3d } from "./board3d"

export const MM = 0.0254

export interface BoardFrame {
	cx: number // board-mils point at the world origin
	cy: number
	thickness: number // mm
}

export function boardFrame(scene: PcbScene, board: Board3d): BoardFrame {
	const [x0, y0, x1, y1] = scene.bounds
	return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, thickness: board.thickness * MM }
}
