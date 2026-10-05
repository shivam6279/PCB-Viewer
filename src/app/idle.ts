// Runs a callback when the browser is idle (or within 1.5 s); returns its cancel.
export function whenIdle(run: () => void): () => void {
	if (typeof requestIdleCallback === "function") {
		const id = requestIdleCallback(run, { timeout: 1500 })
		return () => cancelIdleCallback(id)
	}
	const id = setTimeout(run, 200)
	return () => clearTimeout(id)
}
