// The layered board (board-geometry.ts) as three.js meshes, coloured from the board's own 3D
// configuration: copper, dielectric bands (core / prepreg) at the edge, the dielectric's faces in the
// mask colour (they are only ever seen through the mask), translucent masks with a sheen, silkscreen,
// plated barrels. Every material dims with a selection elsewhere.
import * as THREE from "three"
import { MeshBVH } from "three-mesh-bvh"
import type { Board3dColors, Rgb } from "./board3d"
import type { GeoMesh } from "./board-geometry"
import { dimmable, srgb, type Dimmer } from "./materials"

export interface BoardLayers {
	group: THREE.Group
	meshes: THREE.Mesh[] // userData: { role, layer, kind }
	materials: THREE.Material[]
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

export function geometryOf(m: GeoMesh): THREE.BufferGeometry {
	const g = new THREE.BufferGeometry()
	g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3))
	g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3))
	g.setIndex(new THREE.BufferAttribute(m.index, 1))
	if (m.bvh) g.boundsTree = MeshBVH.deserialize({ ...m.bvh, index: m.index } as unknown as Parameters<typeof MeshBVH.deserialize>[0], g, { setIndex: false })
	g.computeBoundingSphere()
	g.computeBoundingBox()
	return g
}

export function buildBoardLayers(meshes: GeoMesh[], c: Board3dColors, dimmer: Dimmer): BoardLayers {
	const phong = (color: Rgb, extra: THREE.MeshPhongMaterialParameters = {}) => dimmable(new THREE.MeshPhongMaterial({ color: srgb(color), specular: 0x000000, ...extra }), dimmer)
	const copper = phong(c.copper)
	// The plating in a hole is the same copper as the pads around it: unlit, in the copper colour, only
	// shaded round the wall (barrelShade) so it reads as a tube.
	const barrel = dimmable(new THREE.MeshBasicMaterial({ color: srgb(c.copper), vertexColors: true, side: THREE.DoubleSide }), dimmer)
	// The board's edge: each dielectric translucent at its configured opacity (core 0.85, prepreg 0.5
	// over the core colour), so the copper planes inside show through the edge.
	const band = (color: Rgb, opacity: number) => phong(color, { side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 })
	const core = band(c.core, c.coreOpacity)
	const prepreg = band(mix(c.core, c.prepreg, c.prepregOpacity), Math.max(c.coreOpacity, c.prepregOpacity))
	const npth = phong(c.core, { side: THREE.DoubleSide })
	// The board's own faces are bare FR4 in the core colour: what a mask opening without copper shows,
	// and what the translucent mask tints everywhere else.
	const surfaceTop = phong(c.core)
	const surfaceBottom = phong(c.core)
	const mask = (color: Rgb, opacity: number) => phong(color, { transparent: true, opacity, depthWrite: false })
	const maskTop = mask(c.topMask, c.topMaskOpacity)
	const maskBottom = mask(c.bottomMask, c.bottomMaskOpacity)
	const silkTop = phong(c.topSilk)
	const silkBottom = phong(c.bottomSilk)

	const group = new THREE.Group()
	const out: THREE.Mesh[] = []
	for (const m of meshes) {
		let material: THREE.Material
		switch (m.role) {
			case "copper":
				material = copper
				break
			case "barrel":
				material = barrel
				break
			case "dielectric":
				material = m.layer === "SURFACE-TOP" ? surfaceTop : m.layer === "SURFACE-BOTTOM" ? surfaceBottom : m.layer === "NPTH" ? npth : m.core ? core : prepreg
				break
			case "mask":
				material = m.layer === "TOPSOLDER" ? maskTop : maskBottom
				break
			case "silk":
				material = m.layer === "TOPOVERLAY" ? silkTop : silkBottom
				break
		}
		const geometry = geometryOf(m)
		if (m.role === "barrel") barrelShade(geometry)
		const mesh = new THREE.Mesh(geometry, material)
		mesh.userData = { role: m.role, layer: m.layer, kind: m.kind }
		mesh.matrixAutoUpdate = false
		group.add(mesh)
		out.push(mesh)
	}
	return { group, meshes: out, materials: [copper, barrel, core, prepreg, npth, surfaceTop, surfaceBottom, maskTop, maskBottom, silkTop, silkBottom] }
}

// Light on a barrel wall from one side across the hole (the side the board's brighter side light comes
// from): the wall facing it a little brighter than the copper, the wall facing away a little darker.
// Gentle both ways: the plating stays the copper colour, never a darker brown.
const BARREL_LIGHT = new THREE.Vector2(1, 0.6).normalize()
const BARREL_SPREAD = 0.3

function barrelShade(g: THREE.BufferGeometry) {
	const n = g.getAttribute("normal") as THREE.BufferAttribute
	const colors = new Float32Array(n.count * 3)
	for (let i = 0; i < n.count; i++) {
		// The normal points into the hole, away from the wall: the wall faces the light when it does.
		const s = 1 + BARREL_SPREAD * (n.getX(i) * BARREL_LIGHT.x + n.getY(i) * BARREL_LIGHT.y)
		colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = s
	}
	g.setAttribute("color", new THREE.BufferAttribute(colors, 3))
}

// A selection's copper (buildHighlightGeometry) in the copper colour, never dimmed. A net or a single
// object goes in the engine's overlay pass (over everything, see BoardEngine.overlay); a part's own
// pads are drawn in the scene after the mask, under the part's body.
export function buildHighlight(meshes: GeoMesh[], c: Board3dColors, overAll: boolean): THREE.Group {
	const material = new THREE.MeshPhongMaterial({
		color: srgb(c.copper),
		specular: 0x000000,
		side: THREE.DoubleSide,
		transparent: !overAll, // in the scene: drawn in the transparent pass, after the mask
		depthTest: true,
		depthWrite: overAll,
		// In the scene the pads sit on the board's own copper: pulled forward. The overlay pass has a
		// depth buffer of its own, where an offset only made steep barrel walls poke through the faces.
		polygonOffset: !overAll,
		polygonOffsetFactor: -2,
		polygonOffsetUnits: -2,
	})
	const group = new THREE.Group()
	for (const m of meshes) {
		const mesh = new THREE.Mesh(geometryOf(m), material)
		mesh.renderOrder = 10
		mesh.raycast = () => {}
		group.add(mesh)
	}
	return group
}
