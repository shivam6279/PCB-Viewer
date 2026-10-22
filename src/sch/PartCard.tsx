import type { ReactNode } from "react"
import type { CompiledComponent } from "../model/compile"
import { partFacts } from "./part-facts"
import { SchPopup, type PopupArea } from "./PortMenu"

function value(v: string): ReactNode {
	return /^https?:\/\/\S+$/i.test(v) ? (
		<a href={v} target="_blank" rel="noreferrer noopener">
			{v}
		</a>
	) : (
		v
	)
}

// The right-click card for a part on the schematic: designator, value, part numbers, parameters.
export function PartCard({ x, y, area, component, actions, onClose }: {
	x: number
	y: number
	area: PopupArea
	component: CompiledComponent
	actions: { label: string; run(): void }[] // the part in the other views
	onClose(): void
}) {
	const { key, other, links } = partFacts(component)
	return (
		<SchPopup x={x} y={y} area={area} className="part-card" label={`Part ${component.designator}`} onClose={onClose}>
			<div className="part-card-head">
				<span className="part-card-designator">{component.designator}</span>
				{component.logicalDesignator && component.logicalDesignator !== component.designator && <span className="part-card-logical">{component.logicalDesignator}</span>}
			</div>
			{component.comment && <div className="part-card-comment">{component.comment}</div>}
			{component.description && component.description !== component.comment && <div className="part-card-desc">{component.description}</div>}
			{key.length > 0 && (
				<dl className="part-card-facts">
					{key.map(f => (
						<div key={f.label}>
							<dt>{f.label}</dt>
							<dd title={f.value}>{value(f.value)}</dd>
						</div>
					))}
				</dl>
			)}
			{links.length > 0 && (
				<div className="part-card-links">
					{links.map(l => (
						<a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener">
							{l.text}
						</a>
					))}
				</div>
			)}
			{other.length > 0 && (
				<details className="part-card-more">
					<summary>Parameters ({other.length})</summary>
					<dl className="part-card-facts">
						{other.map(p => (
							<div key={p.name}>
								<dt title={p.name}>{p.name}</dt>
								<dd title={p.value}>{value(p.value.trim())}</dd>
							</div>
						))}
					</dl>
				</details>
			)}
			{actions.length > 0 && (
				<div className="part-card-actions">
					{actions.map(a => (
						<button
							key={a.label}
							role="menuitem"
							onClick={() => {
								onClose()
								a.run()
							}}
						>
							{a.label}
						</button>
					))}
				</div>
			)}
		</SchPopup>
	)
}
