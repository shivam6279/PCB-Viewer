// The board comparison off the page: two boards' artwork cut and compared with Clipper takes seconds on
// a big board.
import { expose } from "comlink"
import type { PcbScene } from "../pcb/scene"
import { diffArtwork } from "./artwork"

const api = {
	diff: (a: PcbScene, b: PcbScene) => diffArtwork(a, b),
}

export type ArtworkWorkerApi = typeof api

expose(api)
