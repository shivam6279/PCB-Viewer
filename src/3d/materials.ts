// What a selection does to everything else: grey and darker (so a selected black part still stands
// out). One shared uniform drives every dimmable material, so a
// selection change is a single number, not a material swap per mesh.
import * as THREE from "three"

export const DIM_LEVEL = 0.5 // luminance kept by the dimmed scene

export interface Dimmer {
	uniform: { value: number } // 0 = normal, 1 = dimmed
}

export function createDimmer(): Dimmer {
	return { uniform: { value: 0 } }
}

// Rewrites a material's shader so it greys and darkens with the dimmer.
export function dimmable<T extends THREE.Material>(m: T, dimmer: Dimmer): T {
	m.onBeforeCompile = shader => {
		shader.uniforms.uDim = dimmer.uniform
		shader.fragmentShader = "uniform float uDim;\n" + shader.fragmentShader.replace(
			"#include <dithering_fragment>",
			`#include <dithering_fragment>
	float dimLum = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
	gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(dimLum * ${DIM_LEVEL.toFixed(2)}), uDim);`,
		)
	}
	m.customProgramCacheKey = () => "dim"
	m.needsUpdate = true
	return m
}

// A colour from the board (sRGB) for three.js.
export const srgb = (c: readonly number[]) => new THREE.Color().setRGB(c[0]!, c[1]!, c[2]!, THREE.SRGBColorSpace)
