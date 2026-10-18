import { useId, type ReactNode } from "react"

// Tree icons, drawn on a 32-unit grid and shown at 16 px: a folder (open while its contents show) and
// a PCB project (a page with a board in front of it).

export function FolderIcon({ open = false }: { open?: boolean }) {
	const id = useId()
	if (open)
		return (
			<svg className="tree-icon-img" width="16" height="16" viewBox="0 0 32 32" aria-hidden>
				<defs>
					<linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor="#f9d77a" />
						<stop offset="1" stopColor="#e39d17" />
					</linearGradient>
					<linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor="#ffeaa3" />
						<stop offset="1" stopColor="#f4bb2e" />
					</linearGradient>
				</defs>
				{/* the back, its tab, the inside showing (a shade darker) */}
				<path d="M2.5 26.5v-20A1.5 1.5 0 0 1 4 5h7.6a1.5 1.5 0 0 1 1.2.6l1.8 2.4H23a1.5 1.5 0 0 1 1.5 1.5V28H4a1.5 1.5 0 0 1-1.5-1.5Z" fill={`url(#${id}b)`} stroke="#a7791a" strokeLinejoin="round" />
				<path d="M3.5 6.5v19" stroke="#fdeebb" strokeOpacity="0.8" />
				{/* the front, tipped forward and out past the back on the right */}
				<path d="M9.2 12.5h20.9a1 1 0 0 1 .95 1.3l-4.1 13.2a1.5 1.5 0 0 1-1.43 1H4.2a.8.8 0 0 1-.76-1.05l4.3-13.4a1.5 1.5 0 0 1 1.46-1.05Z" fill={`url(#${id}f)`} stroke="#a7791a" strokeLinejoin="round" />
				<path d="M9.6 13.6h20" stroke="#fff4cc" strokeOpacity="0.9" />
			</svg>
		)
	return (
		<svg className="tree-icon-img" width="16" height="16" viewBox="0 0 32 32" aria-hidden>
			<defs>
				<linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="#fcdc88" />
					<stop offset="1" stopColor="#efae22" />
				</linearGradient>
			</defs>
			{/* the body and its tab, the front's top edge across it */}
			<path d="M2.5 26.5v-20A1.5 1.5 0 0 1 4 5h7.6a1.5 1.5 0 0 1 1.2.6l1.8 2.4H28a1.5 1.5 0 0 1 1.5 1.5v17A1.5 1.5 0 0 1 28 28H4a1.5 1.5 0 0 1-1.5-1.5Z" fill={`url(#${id}b)`} stroke="#a7791a" strokeLinejoin="round" />
			<path d="M2.5 11.5h27" stroke="#b38a2c" />
			<path d="M3.5 12.5h25" stroke="#fdedb8" strokeOpacity="0.9" />
		</svg>
	)
}

export function ProjectIcon() {
	const id = useId()
	return (
		<svg className="tree-icon-img" width="16" height="16" viewBox="0 0 32 32" aria-hidden>
			<defs>
				<linearGradient id={`${id}p`} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor="#fcfdfd" />
					<stop offset="1" stopColor="#dfe7ef" />
				</linearGradient>
				<linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="#0a9a66" />
					<stop offset="1" stopColor="#07714d" />
				</linearGradient>
			</defs>
			{/* the page, its corner folded */}
			<path d="M12.5 1.5h10l7 7v19h-17Z" fill={`url(#${id}p)`} stroke="#9aa0bd" strokeLinejoin="round" />
			<path d="M22.5 1.5v7h7" fill="#c6cadc" stroke="#9aa0bd" strokeLinejoin="round" />
			{/* the board */}
			<rect x="0.5" y="11.5" width="25" height="17" rx="1" fill={`url(#${id}g)`} stroke="#00663f" />
			<path d="M1.5 12.5h23" stroke="#62d9bb" />
			{/* pads down its left side */}
			<g fill="#f4f6f7">
				<rect x="2.5" y="15" width="7" height="1.6" rx="0.4" />
				<rect x="2.5" y="18.5" width="7" height="1.6" rx="0.4" />
				<rect x="2.5" y="22" width="7" height="1.6" rx="0.4" />
			</g>
			{/* a chip on the right, its legs past the board's edge */}
			<rect x="12.5" y="15.5" width="10" height="9" rx="0.8" fill="#005d3c" />
			<rect x="14.5" y="17.5" width="6" height="5" rx="0.5" fill="#cfe0da" />
			<g fill="#c7e43a" stroke="#005d3c" strokeWidth="0.6">
				<rect x="13.6" y="27.8" width="1.6" height="3" />
				<rect x="16.7" y="27.8" width="1.6" height="3" />
				<rect x="19.8" y="27.8" width="1.6" height="3" />
			</g>
		</svg>
	)
}

export type DocKind = "sch" | "pcb" | "variant" | "outjob" | "bom" | "file"

// A project document's icon: a schematic sheet (its title block in the corner), a board, an assembly
// variant (a board with parts struck off), an output job (a folder sending files out), a bill of
// materials, or any other file (a page).
export function DocIcon({ kind }: { kind: DocKind }) {
	const id = useId()
	const svg = (body: ReactNode) => (
		<svg className="tree-icon-img" width="16" height="16" viewBox="0 0 32 32" aria-hidden>
			{body}
		</svg>
	)
	const page = (x: number) => (
		<>
			<linearGradient id={`${id}p`} x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stopColor="#fcfdfd" />
				<stop offset="1" stopColor="#dbe4ee" />
			</linearGradient>
			<path d={`M${x + 0.5} 1.5h12l7 7v22h-19Z`} fill={`url(#${id}p)`} stroke="#9aa0bd" strokeLinejoin="round" />
			<path d={`M${x + 12.5} 1.5v7h7`} fill="#c9cddf" stroke="#9aa0bd" strokeLinejoin="round" />
		</>
	)
	switch (kind) {
		case "sch":
			return svg(
				<>
					<linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor="#fde7a2" />
						<stop offset="1" stopColor="#f4c64e" />
					</linearGradient>
					<rect x="1.5" y="5.5" width="29" height="21" rx="1" fill={`url(#${id}s)`} stroke="#ab8424" />
					{/* the title block */}
					<path d="M17.5 26.5v-8h13M17.5 22.5h13M24 22.5v4" fill="none" stroke="#ab8424" />
				</>,
			)
		case "pcb":
			return svg(
				<>
					<linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor="#12c08f" />
						<stop offset="1" stopColor="#038656" />
					</linearGradient>
					<rect x="1.5" y="3.5" width="29" height="21" rx="1" fill={`url(#${id}g)`} stroke="#00663f" />
					<path d="M2.5 4.5h27" stroke="#7de3c6" />
					{/* pads down the left */}
					<g fill="#f4f8f6">
						<rect x="4" y="7.5" width="2" height="2" />
						<rect x="7.5" y="7.8" width="6" height="1.4" />
						<rect x="4" y="11.5" width="2" height="2" />
						<rect x="7.5" y="11.8" width="6" height="1.4" />
						<rect x="4" y="15.5" width="2" height="2" />
						<rect x="7.5" y="15.8" width="6" height="1.4" />
					</g>
					{/* a chip */}
					<rect x="17.5" y="6.5" width="9" height="9" rx="0.8" fill="#d6dedb" stroke="#4d6b60" />
					<rect x="19.5" y="8.5" width="5" height="5" fill="#9fb2ab" />
					{/* a connector off its lower edge */}
					<rect x="14.5" y="20.5" width="15" height="7" fill="#005d3c" stroke="#00432b" />
					<g fill="#d6ea52">
						<rect x="16" y="22" width="1.6" height="9" />
						<rect x="19.4" y="22" width="1.6" height="9" />
						<rect x="22.8" y="22" width="1.6" height="9" />
						<rect x="26.2" y="22" width="1.6" height="9" />
					</g>
				</>,
			)
		case "variant":
			return svg(
				<>
					<linearGradient id={`${id}v`} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor="#d5efc9" />
						<stop offset="1" stopColor="#8fcc80" />
					</linearGradient>
					<rect x="1.5" y="4.5" width="24" height="19" rx="1" fill={`url(#${id}v)`} stroke="#5e8f55" />
					<path d="M2.5 5.5h22" stroke="#effae9" />
					{/* parts struck off */}
					<rect x="12.5" y="15.5" width="18" height="13" rx="1" fill="#2fa36b" stroke="#1d7a4d" />
					<path d="M15.5 18.5l4 4m0-4-4 4M23.5 18.5l4 4m0-4-4 4" stroke="#ff4b4b" strokeWidth="1.6" strokeLinecap="round" />
				</>,
			)
		case "outjob":
			return svg(
				<>
					<linearGradient id={`${id}o`} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor="#fcdc88" />
						<stop offset="1" stopColor="#efae22" />
					</linearGradient>
					<path d="M1.5 22.5v-15A1.5 1.5 0 0 1 3 6h6.6a1.5 1.5 0 0 1 1.2.6L12.6 9H25a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 25 24H3a1.5 1.5 0 0 1-1.5-1.5Z" fill={`url(#${id}o)`} stroke="#a7791a" strokeLinejoin="round" />
					{/* sending out */}
					<rect x="13.5" y="16.5" width="17" height="13" rx="1" fill="#f4f8ff" stroke="#2f6fd6" strokeWidth="1.4" />
					<path d="M17 23h8m-3.5-3.5L25 23l-3.5 3.5" fill="none" stroke="#2f6fd6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
				</>,
			)
		case "bom":
			return svg(
				<>
					{page(9)}
					{/* a table on the page */}
					<path d="M12 13.5h14M12 17.5h14M12 21.5h14M12 25.5h14M16 11.5v16" stroke="#8d94b3" />
				</>,
			)
		default:
			return svg(
				<>
					{page(6)}
					<path d="M10 13.5h13M10 17.5h13M10 21.5h13M10 25.5h9" stroke="#8d94b3" />
				</>,
			)
	}
}

// The icon for a file of the project that isn't a sheet or a board, by its extension.
export function otherDocKind(name: string): DocKind {
	const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
	return ext === "outjob" ? "outjob" : ext === "bomdoc" ? "bom" : "file"
}
