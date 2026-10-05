import { create } from "zustand"

// The commit being opened from GitHub, with a file count, so the screen the user clicked on can
// show progress instead of going blank.
export interface Opening {
	sha: string
	done: number
	total: number
}

// `error` is a failed switch from inside the viewer, which stays on the commit it had.
export const useOpening = create<{ opening: Opening | null; error: string | null }>(() => ({ opening: null, error: null }))

export function openingLabel(o: Opening): string {
	return o.total > 0 ? `${o.done} of ${o.total} files` : "Listing files…"
}
