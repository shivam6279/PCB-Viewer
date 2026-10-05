import { useEffect, useState } from "react"
import type { Parser } from "../parse/parser"
import type { ProjectData } from "../parse/project-data"
import type { PcbScene } from "./scene"

export type SceneState = { status: "loading" } | { status: "error"; message: string } | { status: "none" } | { status: "ready"; scene: PcbScene }

// One board scene per compiled project, shared by the PCB view and the inspector, kept across tab switches.
const scenes = new WeakMap<ProjectData, Promise<PcbScene | null>>()

// The board scene of a compiled project, requested once and shared (the 3D prefetch uses it too).
export function pcbScene(parser: Parser, data: ProjectData): Promise<PcbScene | null> {
	let pending = scenes.get(data)
	if (!pending) {
		pending = parser.getPcbScene()
		pending.catch(() => scenes.delete(data))
		scenes.set(data, pending)
	}
	return pending
}

export function usePcbScene(parser: Parser, data: ProjectData | null, error: string | null = null): SceneState {
	const [state, setState] = useState<SceneState>({ status: "loading" })
	useEffect(() => {
		if (error !== null) return setState({ status: "error", message: error })
		if (!data) return setState({ status: "loading" })
		if (!data.pcb) return setState({ status: "none" })
		let current = true
		pcbScene(parser, data).then(
			scene => current && setState(scene ? { status: "ready", scene } : { status: "none" }),
			e => current && setState({ status: "error", message: e instanceof Error ? e.message : String(e) }),
		)
		return () => {
			current = false
		}
	}, [parser, data, error])
	return state
}
