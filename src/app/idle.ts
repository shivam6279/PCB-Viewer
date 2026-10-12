// Runs a callback when the browser is idle AND the user has paused: no pointer, wheel or key input for
// QUIET_MS. Background work (building a hidden view, redrawing one) can block the main thread for a few
// hundred ms; started mid-pan it would freeze the view being used. requestIdleCallback alone fires in
// the gaps between a pan's frames. Returns its cancel.
const QUIET_MS = 1000
let lastInput = -Infinity
if (typeof window !== "undefined") {
	const touch = () => {
		lastInput = performance.now()
	}
	for (const type of ["pointerdown", "pointermove", "wheel", "keydown"]) window.addEventListener(type, touch, { capture: true, passive: true })
}

export function whenIdle(run: () => void): () => void {
	let cancel = () => {}
	const attempt = () => {
		const wait = lastInput + QUIET_MS - performance.now()
		if (wait > 0) {
			const id = setTimeout(attempt, wait)
			cancel = () => clearTimeout(id)
		} else if (typeof requestIdleCallback === "function") {
			const id = requestIdleCallback(() => (performance.now() - lastInput < QUIET_MS ? attempt() : run()), { timeout: 1500 })
			cancel = () => cancelIdleCallback(id)
		} else {
			const id = setTimeout(run, 200)
			cancel = () => clearTimeout(id)
		}
	}
	attempt()
	return () => cancel()
}
