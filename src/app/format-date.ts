// "3 Oct 2026, 14:05" in the viewer's locale; the year is dropped for this year's dates.
export function formatDate(iso: string, now = new Date()): string {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return ""
	const sameYear = d.getFullYear() === now.getFullYear()
	return d.toLocaleString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), hour: "2-digit", minute: "2-digit" })
}
