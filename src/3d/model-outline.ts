// Where a body's 3D model really sits on the board, seen from above: the corners of the model's own
// extent, placed as the 3D view places it (see Board3dBody), in board mils. A library's stored body
// outline can be far larger than its model (a SOT-23-5 drawn as 5.1 x 3.9 mm around a 2.8 x 2.9 mm
// model), so the PCB view fits each part's box to these once the models are in. Pure: no three.js.
import { fitPartBox, type PcbScene } from "../pcb/scene"
import type { Board3d, Board3dBody } from "./board3d"
import { MM } from "./frame"
import type { StepMesh } from "./step-mesh"

const DEG = Math.PI / 180

const extents = new WeakMap<StepMesh, number[] | null>()

// A model's extent in its own frame (mm): x0, y0, z0, x1, y1, z1; null for an empty mesh.
function extent(mesh: StepMesh): number[] | null {
	if (extents.has(mesh)) return extents.get(mesh)!
	const p = mesh.positions
	const e = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
	for (let i = 0; i + 2 < p.length; i += 3)
		for (let k = 0; k < 3; k++) {
			e[k] = Math.min(e[k]!, p[i + k]!)
			e[k + 3] = Math.max(e[k + 3]!, p[i + k]!)
		}
	const out = Number.isFinite(e[0]) ? e : null
	extents.set(mesh, out)
	return out
}

// The eight corners of the model's extent as placed, flattened onto the board: one ring of x,y (mils).
export function modelOutline(b: Board3dBody, mesh: StepMesh): number[] | null {
	const e = extent(mesh)
	if (!e) return null
	const [sx, cx] = [Math.sin(b.rx * DEG), Math.cos(b.rx * DEG)]
	const [sy, cy] = [Math.sin(b.ry * DEG), Math.cos(b.ry * DEG)]
	const [sz, cz] = [Math.sin(b.rz * DEG), Math.cos(b.rz * DEG)]
	const out: number[] = []
	for (const x of [e[0]!, e[3]!])
		for (const y of [e[1]!, e[4]!])
			for (const z of [e[2]!, e[5]!]) {
				// Rz · Ry · Rx, applied right to left.
				const y1 = y * cx - z * sx, z1 = y * sx + z * cx
				const x2 = x * cy + z1 * sy
				const x3 = x2 * cz - y1 * sz, y3 = x2 * sz + y1 * cz
				// The bottom side is turned over about x first: y runs the other way.
				out.push(b.x + x3 / MM, b.y + (b.side === "top" ? y3 : -y3) / MM)
			}
	return out
}

// Fits every part that has a 3D model to the model's outline (its other bodies keep their stored
// outlines; a model that failed to convert keeps its stored outline too). Parts without a model are
// left as they are. Changes the scene's boxes in place.
export function fitBoxesToModels(scene: PcbScene, board: Board3d, models: Map<string, StepMesh | null>) {
	const byComponent = new Map<number, Board3dBody[]>()
	for (const b of board.bodies) if (b.component !== null) byComponent.set(b.component, [...(byComponent.get(b.component) ?? []), b])
	for (const [i, bodies] of byComponent) {
		const c = scene.components[i]
		if (!c || !bodies.some(b => b.model && models.get(b.model))) continue
		const rings = bodies.flatMap(b => {
			const mesh = b.model ? models.get(b.model) : null
			const fitted = mesh ? modelOutline(b, mesh) : null
			return fitted ? [fitted] : b.contour
		})
		fitPartBox(c, scene.objects, rings)
	}
}
