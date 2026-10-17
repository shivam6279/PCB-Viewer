import { useState } from "react"

// Whether the project view's tree is folded away, remembered in this browser.
const KEY = "viewer-sidebar-collapsed"

export function useSidebarCollapsed(): [boolean, () => void] {
	const [collapsed, setCollapsed] = useState(read)
	const toggle = () =>
		setCollapsed(c => {
			write(!c)
			return !c
		})
	return [collapsed, toggle]
}

function read(): boolean {
	try {
		return localStorage.getItem(KEY) === "1"
	} catch {
		return false
	}
}

function write(collapsed: boolean): void {
	try {
		localStorage.setItem(KEY, collapsed ? "1" : "0")
	} catch {
		// storage blocked: it just isn't remembered
	}
}
