// Pan/zoom as SVG viewBox math. A view always has the container's aspect ratio,
// so screen pixels map to world units with one scale factor.

export interface ViewBox {
	x: number
	y: number
	w: number
	h: number
}

export interface Size {
	width: number
	height: number
}

export interface ZoomLimits {
	minW: number
	maxW: number
}

export function fitView(content: ViewBox, container: Size, margin = 0.04): ViewBox {
	const aspect = container.width / container.height
	let w = content.w * (1 + 2 * margin)
	let h = content.h * (1 + 2 * margin)
	if (w / h > aspect) h = w / aspect
	else w = h * aspect
	return { x: content.x + content.w / 2 - w / 2, y: content.y + content.h / 2 - h / 2, w, h }
}

export function screenToWorld(view: ViewBox, container: Size, px: number, py: number): { x: number; y: number } {
	return { x: view.x + (px / container.width) * view.w, y: view.y + (py / container.height) * view.h }
}

export function zoomAt(view: ViewBox, factor: number, px: number, py: number, container: Size, limits?: ZoomLimits): ViewBox {
	let w = view.w / factor
	if (limits) w = Math.min(limits.maxW, Math.max(limits.minW, w))
	const h = w * (view.h / view.w)
	const anchor = screenToWorld(view, container, px, py)
	return { x: anchor.x - (px / container.width) * w, y: anchor.y - (py / container.height) * h, w, h }
}

export function panBy(view: ViewBox, dxPx: number, dyPx: number, container: Size): ViewBox {
	return { ...view, x: view.x - (dxPx * view.w) / container.width, y: view.y - (dyPx * view.h) / container.height }
}
