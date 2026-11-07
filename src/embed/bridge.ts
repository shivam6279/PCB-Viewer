import { create } from "zustand"
import type { Rgb } from "../3d/board3d"

// The 3D view driven from outside (the embed page, inside a host app such as a pick-and-place
// controller). Parts are named by their board designator. Empty / null = the viewer as usual.
export interface Embed3d {
	lit: Set<string> | null // parts shown lit, everything else greyed (like a selection); null: none
	tints: Map<string, { color: Rgb; opacity: number }> // parts drawn in one flat colour
	onPick: ((designator: string | null) => void) | null // set: a click reports the part instead of selecting it
	leftPans: boolean // a left drag pans instead of turning
}

export const useEmbed3d = create<Embed3d>(() => ({ lit: null, tints: new Map(), onPick: null, leftPans: false }))
