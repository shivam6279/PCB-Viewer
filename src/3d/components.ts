// Component bodies as three.js meshes: STEP models placed by Altium's rule (see Board3dBody), and
// extruded outlines for bodies without a model. One group per component, so a click can find the
// component and a selection can grey out the others.
import * as THREE from "three"
import type { Board3d, Board3dBody, Rgb } from "./board3d"
import { MM, type BoardFrame } from "./frame"
import { dimmable, srgb, type Dimmer } from "./materials"
import type { StepMesh } from "./step-mesh"

const DEG = Math.PI / 180

// Altium's placement of a body's model, in world mm (see Board3dBody).
export function bodyMatrix(b: Board3dBody, f: BoardFrame): THREE.Matrix4 {
	const model = new THREE.Matrix4().makeRotationZ(b.rz * DEG)
		.multiply(new THREE.Matrix4().makeRotationY(b.ry * DEG))
		.multiply(new THREE.Matrix4().makeRotationX(b.rx * DEG))
	const x = (b.x - f.cx) * MM, y = (b.y - f.cy) * MM
	if (b.side === "top") return new THREE.Matrix4().makeTranslation(x, y, b.dz * MM).multiply(model)
	return new THREE.Matrix4().makeTranslation(x, y, -f.thickness - b.dz * MM).multiply(new THREE.Matrix4().makeRotationX(Math.PI)).multiply(model)
}

// Geometry for one STEP mesh, its uncoloured faces painted in the body's colour (cached per colour).
const geometries = new WeakMap<StepMesh, Map<string, THREE.BufferGeometry>>()
export function stepGeometry(mesh: StepMesh, fallback: Rgb): THREE.BufferGeometry {
	let byColor = geometries.get(mesh)
	if (!byColor) geometries.set(mesh, (byColor = new Map()))
	const key = fallback.join(",")
	let g = byColor.get(key)
	if (g) return g
	g = new THREE.BufferGeometry()
	g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3))
	g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3))
	const n = mesh.positions.length / 3
	const colors = new Float32Array(n * 3)
	for (let i = 0; i < n; i++) {
		const own = mesh.colors[i * 4 + 3]! > 0
		// A STEP file's colours are taken as linear (an STM32 body of 0.07 shows as #4b4b4b, an
		// aluminium can of 0.50/0.56/0.60 as #bec9cf); body colours are sRGB.
		for (let c = 0; c < 3; c++) colors[i * 3 + c] = own ? mesh.colors[i * 4 + c]! / 255 : srgbToLinear(fallback[c]!)
	}
	g.setAttribute("color", new THREE.BufferAttribute(colors, 3))
	g.setIndex(new THREE.BufferAttribute(mesh.index, 1))
	g.computeBoundingSphere()
	byColor.set(key, g)
	return g
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

// A body without a model: its outline extruded from the standoff to its height.
export function extrudedBody(b: Board3dBody, f: BoardFrame): THREE.BufferGeometry | null {
	const ring = b.contour[0]
	if (!ring || ring.length < 6) return null
	const shape = new THREE.Shape()
	for (let k = 0; k + 1 < ring.length; k += 2) {
		const x = (ring[k]! - f.cx) * MM, y = (ring[k + 1]! - f.cy) * MM
		if (k === 0) shape.moveTo(x, y)
		else shape.lineTo(x, y)
	}
	const depth = Math.max((b.height - b.standoff) * MM, 0.01)
	const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false })
	if (b.side === "top") g.translate(0, 0, b.standoff * MM)
	else g.translate(0, 0, -f.thickness - b.standoff * MM - depth)
	return g
}

export interface ComponentMaterials {
	dimmer: Dimmer
	solid: THREE.MeshPhongMaterial // vertex-coloured, dims with a selection elsewhere
	lit: THREE.MeshPhongMaterial // the same, never dimmed: the selected part
	flat: Map<string, THREE.MeshPhongMaterial> // extruded bodies, by colour + opacity + lit
	translucent: Map<string, THREE.MeshPhongMaterial> // STEP bodies with an opacity below 1
}

// The material for a STEP body: vertex-coloured, translucent at the body's 3D opacity (an LED lens
// at 0.5 shows its green die), dimmed by a selection elsewhere unless lit (selected).
export function stepMaterial(mats: ComponentMaterials, opacity: number, lit: boolean): THREE.MeshPhongMaterial {
	if (opacity >= 1) return lit ? mats.lit : mats.solid
	const key = `${opacity}|${lit}`
	let m = mats.translucent.get(key)
	if (!m) {
		m = new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x000000, side: THREE.DoubleSide, transparent: true, opacity, depthWrite: false })
		if (!lit) dimmable(m, mats.dimmer)
		mats.translucent.set(key, m)
	}
	return m
}

export function componentMaterials(dimmer: Dimmer): ComponentMaterials {
	const make = () => new THREE.MeshPhongMaterial({ vertexColors: true, specular: 0x000000, side: THREE.DoubleSide })
	return { dimmer, solid: dimmable(make(), dimmer), lit: make(), flat: new Map(), translucent: new Map() }
}

export function flatMaterial(mats: ComponentMaterials, color: Rgb, opacity: number, lit: boolean): THREE.MeshPhongMaterial {
	const key = `${color.join(",")}|${opacity}|${lit}`
	let m = mats.flat.get(key)
	if (!m) {
		m = new THREE.MeshPhongMaterial({ color: srgb(color), specular: 0x000000, transparent: opacity < 1, opacity })
		if (!lit) dimmable(m, mats.dimmer)
		mats.flat.set(key, m)
	}
	return m
}

export interface PlacedBody {
	body: Board3dBody
	mesh: THREE.Mesh
}

// One mesh for a body (STEP when its model is ready, else the extruded outline).
export function bodyMesh(b: Board3dBody, f: BoardFrame, mats: ComponentMaterials, step: StepMesh | null): THREE.Mesh | null {
	if (b.model && step) {
		const mesh = new THREE.Mesh(stepGeometry(step, b.color), stepMaterial(mats, b.opacity, false))
		mesh.matrixAutoUpdate = false
		mesh.matrix.copy(bodyMatrix(b, f))
		return mesh
	}
	if (b.model) return null // waiting for the model (or it failed: see failedBody)
	const g = extrudedBody(b, f)
	return g ? new THREE.Mesh(g, flatMaterial(mats, b.color, b.opacity, false)) : null
}

// A model that could not be converted shows as a grey block over its outline.
export function failedBody(b: Board3dBody, f: BoardFrame, mats: ComponentMaterials): THREE.Mesh | null {
	const g = extrudedBody(b, f)
	return g ? new THREE.Mesh(g, flatMaterial(mats, [0.5, 0.5, 0.5], 1, false)) : null
}

export type { Board3d }
