import * as THREE from "three"

// Camera state as the engine keeps it: the camera sits at centre + q·(offset.x, offset.y, distance),
// looking down its own -z, where centre is the middle of the board (half-way through its thickness).
export interface OrbitView {
	offset: THREE.Vector2
	quaternion: THREE.Quaternion
	distance: number
}

// The board in world mm: its centre plane z = planeZ, its outline's box half-extents about the origin.
export interface OrbitBoard {
	centre: THREE.Vector3
	halfX: number
	halfY: number
}

const GRAZING = 1e-3 // |dir.z| below this: the centre line runs along the board

// The point the view turns about: where the line through the middle of the screen crosses the board's
// mid-plane (half-way through its thickness), so what is in the middle stays there while turning.
// Seen edge-on, or with the middle of the screen off the board, it is the nearest point of that plane,
// kept within the board's outline box so the pivot never runs off to infinity.
// `line`: the whole centre line counts, behind the camera too (orthographic, where the camera's place
// along its axis is arbitrary).
export function pivotOf(view: OrbitView, board: OrbitBoard, line = false): THREE.Vector3 {
	const q = view.quaternion
	const origin = board.centre.clone().add(new THREE.Vector3(view.offset.x, view.offset.y, view.distance).applyQuaternion(q))
	const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
	const z = board.centre.z
	let p: THREE.Vector3
	const s = Math.abs(dir.z) > GRAZING ? (z - origin.z) / dir.z : -1
	if (s > 0 || (line && Math.abs(dir.z) > GRAZING)) p = origin.clone().addScaledVector(dir, s)
	else {
		// No crossing in front of the camera: the centre line's point nearest the board centre, on the plane.
		const t = Math.max(0, board.centre.clone().sub(origin).dot(dir))
		p = origin.clone().addScaledVector(dir, t)
		p.z = z
	}
	p.x = THREE.MathUtils.clamp(p.x, board.centre.x - board.halfX, board.centre.x + board.halfX)
	p.y = THREE.MathUtils.clamp(p.y, board.centre.y - board.halfY, board.centre.y + board.halfY)
	return p
}

// The view turned by `r` (a world rotation) about `pivot`.
export function orbit(view: OrbitView, board: OrbitBoard, pivot: THREE.Vector3, r: THREE.Quaternion): OrbitView {
	const q = view.quaternion
	const camera = board.centre.clone().add(new THREE.Vector3(view.offset.x, view.offset.y, view.distance).applyQuaternion(q))
	const moved = camera.sub(pivot).applyQuaternion(r).add(pivot)
	const q2 = r.clone().multiply(q).normalize()
	// Back into the engine's terms: the camera's place relative to the board centre, in its own axes.
	const local = moved.sub(board.centre).applyQuaternion(q2.clone().invert())
	return { quaternion: q2, offset: new THREE.Vector2(local.x, local.y), distance: local.z }
}
