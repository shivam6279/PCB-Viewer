// Which board a 3D load is for: a project's source and the board's path in it. Lets the load started
// when the project opens (startBoard3d) be found again by the 3D view. Its own module so the shell can
// name a board without loading any 3D code.
const ids = new WeakMap<object, number>()
let next = 0

export function boardKey(source: object, path: string): string {
	if (!ids.has(source)) ids.set(source, ++next)
	return `${ids.get(source)}:${path}`
}
