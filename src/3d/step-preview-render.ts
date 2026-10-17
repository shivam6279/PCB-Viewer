// The export dialog's preview picture: the preview board's STEP file (as the exporter wrote it) read
// back, in the colours it was written in, and rendered close up to an image. The solder mask is drawn
// a little see-through, as in the 3D view, so copper left under it shows; everything else is solid.
import * as THREE from "three"
import { stepGeometry } from "./components"
import { stepAssemblyMesh } from "./step-mesh"
import type { StepPreviewFile } from "./step-export/preview.worker"

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

export const PREVIEW_SIZE = { width: 480, height: 320 } // CSS px; drawn at twice that

let renderer: THREE.WebGLRenderer | null = null

export async function renderStepPreview(file: StepPreviewFile): Promise<string | null> {
	const mesh = await stepAssemblyMesh(file.bytes, file.layers, file.models)
	if (!mesh) return null
	const geometry = stepGeometry(mesh, [0.6, 0.6, 0.6]).clone()
	// The mask's triangles (its colour, as read back: linear) drawn last, with their own material.
	const maskBytes = (file.layers["Top Solder Mask"] ?? [0, 0, 0]).map(c => Math.trunc(srgbToLinear(c) * 255))
	const isMask = (v: number) => maskBytes.every((c, k) => Math.abs(mesh.colors[v * 4 + k]! - c) <= 1) && mesh.colors[v * 4 + 3]! > 0
	const solid: number[] = [], masked: number[] = []
	for (let t = 0; t < mesh.index.length; t += 3) (isMask(mesh.index[t]!) ? masked : solid).push(mesh.index[t]!, mesh.index[t + 1]!, mesh.index[t + 2]!)
	geometry.setIndex([...solid, ...masked])
	geometry.addGroup(0, solid.length, 0)
	geometry.addGroup(solid.length, masked.length, 1)
	const materials = [
		new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }),
		// Its top face only: seen through, its other faces' triangles would show.
		new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0, transparent: true, opacity: 0.65, side: THREE.FrontSide }),
	]

	const scene = new THREE.Scene()
	scene.background = new THREE.Color(0xcccccc)
	scene.add(new THREE.Mesh(geometry, materials))
	// Solid vias: where each hole would be, the copper in a darker shade.
	const copper = file.layers["Top Copper"] ?? [0.86, 0.66, 0.27]
	const mark = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(copper[0]! * 0.5, copper[1]! * 0.5, copper[2]! * 0.5, THREE.SRGBColorSpace), roughness: 0.55, metalness: 0.05 })
	const disc = new THREE.CircleGeometry(1, 32)
	for (const v of file.viaMarks) {
		const m = new THREE.Mesh(disc, mark)
		m.position.set(v.x, v.y, v.z)
		m.scale.setScalar(v.r)
		scene.add(m)
	}
	scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.6))
	const key = new THREE.DirectionalLight(0xffffff, 2.2)
	key.position.set(-4, -6, 10)
	const fill = new THREE.DirectionalLight(0xffffff, 0.6)
	fill.position.set(8, 2, 4)
	scene.add(key, fill)

	// The whole patch, close up, from above, a little to the front right (the board's top face is at z = 1.6).
	const target = new THREE.Vector3(5.6, 3.9, 2.4)
	const camera = new THREE.PerspectiveCamera(32, PREVIEW_SIZE.width / PREVIEW_SIZE.height, 0.1, 200)
	camera.up.set(0, 0, 1)
	camera.position.copy(target).add(new THREE.Vector3(4.2, -9.5, 15.5))
	camera.lookAt(target)

	renderer ??= new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
	renderer.setPixelRatio(2)
	renderer.setSize(PREVIEW_SIZE.width, PREVIEW_SIZE.height, false)
	renderer.outputColorSpace = THREE.SRGBColorSpace
	renderer.render(scene, camera)
	const url = renderer.domElement.toDataURL("image/webp", 0.85)
	geometry.dispose()
	for (const m of materials) m.dispose()
	mark.dispose()
	disc.dispose()
	return url
}
