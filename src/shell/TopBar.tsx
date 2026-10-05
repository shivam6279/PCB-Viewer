import { ChevronLeft, Search } from "lucide-react"
import type { ReactNode } from "react"

export function TopBar({ title, subtitle, onBack, children }: { title: string; subtitle: string; onBack(): void; children?: ReactNode }) {
	return (
		<header className="topbar">
			<button className="topbar-back" aria-label="Back to start" onClick={onBack}>
				<ChevronLeft size={20} />
			</button>
			<div className="topbar-title">
				<div>{title}</div>
				<div className="sub">{subtitle}</div>
			</div>
			<div className="topbar-end">
				{children}
				<button className="icon-btn topbar-search-icon" aria-label="Search">
					<Search size={17} />
				</button>
			</div>
		</header>
	)
}
