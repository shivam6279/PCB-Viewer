import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown, ChevronRight, X } from "lucide-react"
import { useAppStore, type Selection, type ViewTab } from "../app/store"
import type { CompiledBundle, CompiledComponent, CompiledNet, CompiledProject } from "../model/compile"
import { flattenHierarchy, type HierarchyNode } from "../model/hierarchy"
import type { ProjectSummary } from "../model/load-project"
import type { PcbData } from "../parse/extract-pcb"
import type { Parser } from "../parse/parser"
import type { ProjectData } from "../parse/project-data"
import type { PcbObject, PcbScene } from "../pcb/scene"
import { netSelection, pcbComponentIndex } from "../pcb/selection"
import { usePcbScene } from "../pcb/use-scene"
import { instanceLabel } from "../sch/interaction"
import { footprintSvg } from "../pcb/footprint-svg"

const MM = 0.0254

// The right-hand properties panel, for whatever is selected in either view.
export function Inspector({ project, data, selection, activeSheetId, parser, tab }: {
	parser: Parser
	project: ProjectSummary
	data: ProjectData
	selection: Selection
	activeSheetId: string | null
	tab: ViewTab
}) {
	const sceneState = usePcbScene(parser, data)
	const scene = sceneState.status === "ready" ? sceneState.scene : null
	const close = () => useAppStore.getState().select(null)
	const views = { tab, project, compiled: data.compiled, activeSheetId }
	switch (selection.kind) {
		case "net": {
			const net = data.compiled.nets[selection.netId]
			return net ? <NetPanel {...views} pcb={data.pcb} net={net} selection={selection} onClose={close} /> : null
		}
		case "bundle": {
			const bundle = data.compiled.bundles[selection.bundleId]
			return bundle ? <BundlePanel {...views} bundle={bundle} selection={selection} onClose={close} /> : null
		}
		case "component": {
			const component = data.compiled.components.find(c => c.id === selection.id)
			if (!component) return null
			const placed = scene ? scene.components[pcbComponentIndex(scene, data.compiled, component.id)] : undefined
			return <ComponentPanel {...views} pcb={data.pcb} scene={scene} component={component} footprintDescription={placed?.footprintDescription ?? ""} selection={selection} onClose={close} />
		}
		case "pcbNet":
			return <BoardNetPanel pcb={data.pcb} name={selection.name} tab={tab} onClose={close} />
		case "pcbObject": {
			const o = scene?.objects[selection.id]
			return o && scene ? <ObjectPanel {...views} scene={scene} pcb={data.pcb} object={o} onClose={close} /> : null
		}
		case "pcbComponent": {
			const c = scene?.components[selection.index]
			if (!c || !scene) return null
			return (
				<aside className="inspector" aria-label="Component properties">
					<Head title={c.designator} onClose={close} views={["PCB", "3D", "BOM"]} active={tabLabel(tab)} onView={v => (v === "PCB" ? useAppStore.getState().showOnPcb(selection) : v === "3D" ? useAppStore.getState().showOn3d(selection) : useAppStore.getState().setTab("bom"))} />
					{c.comment && <div className="inspector-heading">{c.comment}</div>}
					<Section title="Footprint">
						<FootprintPicture scene={scene} index={selection.index} label={`Footprint ${c.footprint}`} />
						<div className="inspector-row">{c.footprint}</div>
						{c.footprintDescription && <div className="inspector-desc">{c.footprintDescription}</div>}
					</Section>
					<Location scene={scene} x={c.x} y={c.y} rotation={c.rotation} layer={c.side === "bottom" ? "BOTTOM" : "TOP"} />
				</aside>
			)
		}
	}
}

interface Views {
	tab: ViewTab
	project: ProjectSummary
	compiled: CompiledProject
	activeSheetId: string | null
}

function Head({ title, onClose, views, active, onView }: { title: ReactNode; onClose(): void; views: string[]; active: string; onView?(view: string): void }) {
	return (
		<>
			<div className="inspector-head">
				<span className="title">{title}</span>
				<button className="inspector-close" aria-label="Close" onClick={onClose}>
					<X size={16} />
				</button>
			</div>
			<div className="inspector-views">
				{views.map(v => (
					<button key={v} className={v === active ? "on" : undefined} disabled={!onView} onClick={() => onView?.(v)}>
						{v}
					</button>
				))}
			</div>
		</>
	)
}

const tabLabel = (tab: ViewTab) => (tab === "sch" ? "SCH" : tab === "pcb" ? "PCB" : tab === "bom" ? "BOM" : "3D")

// SCH / PCB buttons: show the same selection in the other view (cross-probing).
function crossProbe(view: string, selection: Selection, compiled: CompiledProject, activeSheetId: string | null) {
	const store = useAppStore.getState()
	if (view === "PCB") return store.showOnPcb(selection)
	if (view === "3D") return store.showOn3d(selection)
	if (view === "BOM") return store.setTab("bom") // the selection stays: its line is marked there
	if (view !== "SCH") return
	if (selection.kind === "net") {
		const net = compiled.nets[selection.netId]
		const here = net?.occurrences.find(o => o.instanceId === activeSheetId) ?? net?.occurrences[0]
		if (here) store.jumpTo(here.instanceId, here.objects, selection)
	} else if (selection.kind === "component") {
		const c = compiled.components.find(c => c.id === selection.id)
		if (c) store.jumpTo(c.instanceId, [c.i], selection)
	}
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	const [open, setOpen] = useState(true)
	return (
		<div className="inspector-section">
			<button onClick={() => setOpen(!open)} aria-expanded={open}>
				{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				{title}
			</button>
			{open && <div className="rows">{children}</div>}
		</div>
	)
}

function NetPanel({ tab, project, compiled, activeSheetId, pcb, net, selection, onClose }: Views & {
	pcb: PcbData | null
	net: CompiledNet
	selection: Selection
	onClose(): void
}) {
	const pcbNet = pcb?.nets.find(n => n.name.toUpperCase() === net.physicalName.toUpperCase())
	const order = flattenHierarchy(project.hierarchy)
	const nodes = order.filter(n => net.occurrences.some(o => o.instanceId === n.id))
	const jump = (node: HierarchyNode) => {
		const objects = net.occurrences.find(o => o.instanceId === node.id)?.objects ?? []
		useAppStore.getState().jumpTo(node.id, objects, selection)
	}
	const current = (n: HierarchyNode) => tab === "sch" && n.id === activeSheetId
	return (
		<aside className="inspector" aria-label="Net properties">
			<Head title={net.physicalName} onClose={onClose} views={["SCH", "PCB", "3D"]} active={tabLabel(tab)} onView={v => crossProbe(v, selection, compiled, activeSheetId)} />
			<dl className="inspector-props">
				{net.physicalName !== net.netName && (
					<>
						<dt>Physical Name</dt>
						<dd title={net.physicalName}>{net.physicalName}</dd>
					</>
				)}
				<dt>Net Name</dt>
				<dd title={net.netName}>{net.netName}</dd>
				{pcbNet && (
					<>
						<dt>Routed Length</dt>
						<dd>{pcbNet.routedLength.toFixed(3)}mm</dd>
					</>
				)}
			</dl>
			<Section title="Connectivity">
				{nodes.map(n => (
					<div key={n.id} className={`inspector-row link${current(n) ? " current" : ""}`} onClick={() => jump(n)}>
						<span className="tree-icon sch" />
						<span className="grow">{instanceLabel(n)}</span>
						{current(n) && <Check size={14} className="tick" />}
					</div>
				))}
			</Section>
			<LayersUsed pcb={pcb} name={net.physicalName} />
		</aside>
	)
}

// A bus or signal harness: where it runs and the nets it carries (each one selectable).
function BundlePanel({ tab, project, compiled, activeSheetId, bundle, selection, onClose }: Views & {
	bundle: CompiledBundle
	selection: Selection
	onClose(): void
}) {
	const nodes = flattenHierarchy(project.hierarchy).filter(n => bundle.occurrences.some(o => o.instanceId === n.id))
	const jump = (node: HierarchyNode) => {
		const objects = bundle.occurrences.find(o => o.instanceId === node.id)?.objects ?? []
		useAppStore.getState().jumpTo(node.id, objects, selection)
	}
	const current = (n: HierarchyNode) => tab === "sch" && n.id === activeSheetId
	const members = bundle.nets.map(id => compiled.nets[id]).filter((n): n is CompiledNet => n !== undefined)
	return (
		<aside className="inspector" aria-label={bundle.kind === "bus" ? "Bus properties" : "Harness properties"}>
			<Head title={bundle.name} onClose={onClose} views={["SCH"]} active={tabLabel(tab)} />
			<dl className="inspector-props">
				<dt>Type</dt>
				<dd>{bundle.kind === "bus" ? "Bus" : "Signal Harness"}</dd>
				<dt>Nets</dt>
				<dd>{members.length}</dd>
			</dl>
			<Section title="Connectivity">
				{nodes.map(n => (
					<div key={n.id} className={`inspector-row link${current(n) ? " current" : ""}`} onClick={() => jump(n)}>
						<span className="tree-icon sch" />
						<span className="grow">{instanceLabel(n)}</span>
						{current(n) && <Check size={14} className="tick" />}
					</div>
				))}
			</Section>
			<Section title="Nets">
				{members.map(net => (
					<div key={net.id} className="inspector-row link" onClick={() => useAppStore.getState().select({ kind: "net", netId: net.id })}>
						<span className="grow">{net.physicalName}</span>
					</div>
				))}
			</Section>
		</aside>
	)
}

function LayersUsed({ pcb, name }: { pcb: PcbData | null; name: string }) {
	const pcbNet = pcb?.nets.find(n => n.name.toUpperCase() === name.toUpperCase())
	if (!pcb || !pcbNet || pcbNet.layers.length === 0) return null
	return (
		<Section title="Layers Used">
			{pcbNet.layers.map(key => {
				const layer = pcb.layers.find(l => l.key === key)
				return (
					<div key={key} className="inspector-row">
						<span className="swatch" style={{ background: layer?.color ?? "#808080" }} />
						<span className="grow">{layer?.name ?? key}</span>
					</div>
				)
			})}
		</Section>
	)
}

// A board net the schematic does not have.
function BoardNetPanel({ pcb, name, tab, onClose }: { pcb: PcbData | null; name: string; tab: ViewTab; onClose(): void }) {
	const pcbNet = pcb?.nets.find(n => n.name.toUpperCase() === name.toUpperCase())
	return (
		<aside className="inspector" aria-label="Net properties">
			<Head title={name} onClose={onClose} views={["PCB", "3D"]} active={tabLabel(tab)} onView={v => (v === "PCB" ? useAppStore.getState().showOnPcb({ kind: "pcbNet", name }) : useAppStore.getState().showOn3d({ kind: "pcbNet", name }))} />
			<dl className="inspector-props">
				<dt>Net Name</dt>
				<dd>{name}</dd>
				{pcbNet && (
					<>
						<dt>Routed Length</dt>
						<dd>{pcbNet.routedLength.toFixed(3)}mm</dd>
					</>
				)}
			</dl>
			<LayersUsed pcb={pcb} name={name} />
		</aside>
	)
}

function NetLink({ name, compiled }: { name: string; compiled: CompiledProject }) {
	return (
		<button className="link-button" onClick={() => useAppStore.getState().showOnPcb(netSelection(name, compiled))}>
			{name}
		</button>
	)
}

function Location({ scene, x, y, rotation, layer }: { scene: PcbScene; x: number; y: number; rotation?: number; layer: string }) {
	const l = scene.layers.find(l => l.key === layer)
	return (
		<Section title="Location">
			<div className="inspector-row">
				X: {((x - scene.origin[0]) * MM).toFixed(3)}mm; Y: {((y - scene.origin[1]) * MM).toFixed(3)}mm
			</div>
			{rotation !== undefined && <div className="inspector-row">Rotation: {formatAngle(rotation)}</div>}
			<div className="inspector-row">
				<span className="swatch" style={{ background: l?.color ?? "#c0c0c0" }} />
				<span className="grow">{l?.name ?? layer}</span>
			</div>
		</Section>
	)
}

const mm = (mils: number) => `${(mils * MM).toFixed(3)}mm`

// A pad, via, track or arc clicked on the board.
function ObjectPanel({ tab, compiled, scene, pcb, object: o, onClose }: Views & { scene: PcbScene; pcb: PcbData | null; object: PcbObject; onClose(): void }) {
	const component = o.component !== null ? scene.components[o.component] : undefined
	const routed = o.net ? pcb?.nets.find(n => n.name.toUpperCase() === o.net!.toUpperCase())?.routedLength : undefined
	const layerName = scene.layers.find(l => l.key === o.layer)?.name ?? o.layer
	const isPad = o.kind === "pad" && o.pad
	// SCH for a pad shows its component on the schematic with the pad's net selected.
	const compiledComponent = component ? compiled.components.find(c => c.uniquePath === component.sourceUniqueId) : undefined
	// The schematic's channel designator (J1_ESC_2): board designators can repeat across channels.
	const designator = compiledComponent?.designator ?? component?.designator ?? ""
	const title = isPad ? `${designator}-${o.pad!.name}` : (o.net ?? (o.kind === "via" ? "Via" : o.kind === "arc" ? "Arc" : "Track"))
	const onView = (v: string) => {
		if (v === "PCB") return useAppStore.getState().showOnPcb({ kind: "pcbObject", id: o.id })
		if (v === "3D") return useAppStore.getState().showOn3d({ kind: "pcbObject", id: o.id })
		if (v === "SCH" && compiledComponent) {
			const net = o.net ? netSelection(o.net, compiled) : null
			useAppStore.getState().jumpTo(compiledComponent.instanceId, [compiledComponent.i], net && net.kind === "net" ? net : { kind: "component", id: compiledComponent.id })
		}
	}
	return (
		<aside className="inspector" aria-label={isPad ? "Pad properties" : o.kind === "via" ? "Via properties" : "Track properties"}>
			<Head title={title} onClose={onClose} views={isPad ? ["SCH", "PCB", "3D"] : ["PCB", "3D"]} active={tabLabel(tab)} onView={onView} />
			{o.net && (
				<dl className="inspector-props">
					<dt>Net Name</dt>
					<dd>
						<NetLink name={o.net} compiled={compiled} />
					</dd>
					{routed !== undefined && (
						<>
							<dt>Routed Length</dt>
							<dd>{routed.toFixed(3)}mm</dd>
						</>
					)}
				</dl>
			)}
			{o.pad && (
				<Section title={o.kind === "via" ? "Via" : "Pad"}>
					{isPad && <Prop name="Name" value={title} />}
					<Prop name="Type" value={o.kind === "via" ? "Via" : o.pad.smd ? "SMD" : o.pad.plated ? "Plated" : "Non-Plated"} />
					{o.pad.holeSize > 0 && <Prop name="Hole Size" value={mm(o.pad.holeSize)} />}
					{isPad && <Prop name="Shape" value={o.pad.shape} />}
					<Prop name={isPad ? "" : "Diameter"} value={isPad ? `${mm(o.pad.sizeX)}; ${mm(o.pad.sizeY)}` : mm(o.pad.sizeX)} />
				</Section>
			)}
			{(o.kind === "track" || o.kind === "arc") && (
				<Section title={o.kind === "arc" ? "Arc" : "Track"}>
					<Prop name="Width" value={mm(o.width ?? 0)} />
					<Prop name="Layer" value={layerName} />
					<Prop name="Length" value={mm(o.length ?? 0)} />
				</Section>
			)}
			<Location scene={scene} x={o.at[0]} y={o.at[1]} rotation={o.kind === "pad" ? o.pad?.rotation : undefined} layer={o.layer} />
		</aside>
	)
}

function Prop({ name, value }: { name: string; value: string }) {
	return (
		<div className="param-row">
			<span className="name">{name}</span>
			<span className="value">{value}</span>
		</div>
	)
}

const PARAMS_SHOWN = 4
const LINK = /^ComponentLink(\d+)(Description|URL)$/i

function ComponentPanel({ tab, compiled, activeSheetId, pcb, scene, component, footprintDescription, selection, onClose }: Views & {
	pcb: PcbData | null
	scene: PcbScene | null
	component: CompiledComponent
	footprintDescription: string
	selection: Selection
	onClose(): void
}) {
	const [more, setMore] = useState(false)
	const placed = pcb?.components.find(c => c.sourceUniqueId === component.uniquePath)
	const placedIndex = scene ? scene.components.findIndex(c => c.sourceUniqueId === component.uniquePath) : -1
	const layerColor = placed ? (pcb!.layers.find(l => l.name === placed.layer)?.color ?? (/bottom/i.test(placed.layer) ? "#0000ff" : "#ff0000")) : null
	// Component links (datasheet, supplier pages) are listed as References, not parameters.
	const links = new Map<string, { description?: string; url?: string }>()
	for (const p of component.parameters) {
		const m = LINK.exec(p.name)
		if (!m) continue
		const entry = links.get(m[1]!) ?? {}
		if (m[2]!.toLowerCase() === "url") entry.url = p.value
		else entry.description = p.value
		links.set(m[1]!, entry)
	}
	const parameters = component.parameters.filter(p => !LINK.test(p.name))
	const params = more ? parameters : parameters.slice(0, PARAMS_SHOWN)
	const title =
		tab === "pcb" && component.logicalDesignator !== component.designator ? `${component.designator} (${component.logicalDesignator})` : component.designator
	return (
		<aside className="inspector" aria-label="Component properties">
			<Head title={title} onClose={onClose} views={["SCH", "PCB", "3D", "BOM"]} active={tabLabel(tab)} onView={v => crossProbe(v, selection, compiled, activeSheetId)} />
			{component.comment && <div className="inspector-heading">{component.comment}</div>}
			{component.description && <div className="inspector-desc">{component.description}</div>}
			{component.footprint && (
				<Section title="Footprint">
					{scene && placedIndex >= 0 && <FootprintPicture scene={scene} index={placedIndex} label={`Footprint ${component.footprint}`} />}
					<div className="inspector-row">
						<span className="grow">{component.footprint}</span>
					</div>
					{footprintDescription && <div className="inspector-desc">{footprintDescription}</div>}
				</Section>
			)}
			{placed && (
				<Section title="Location">
					<div className="inspector-row">
						X: {placed.x.toFixed(3)}mm; Y: {placed.y.toFixed(3)}mm
					</div>
					<div className="inspector-row">Rotation: {formatAngle(placed.rotation)}</div>
					<div className="inspector-row">
						<span className="swatch" style={{ background: layerColor ?? undefined }} />
						<span className="grow">{placed.layer}</span>
					</div>
				</Section>
			)}
			{parameters.length > 0 && (
				<Section title="Parameters">
					{params.map(p => (
						<div key={p.name} className="param-row">
							<span className="name" title={p.name}>
								{p.name}
							</span>
							<span className="value">{paramValue(p.value)}</span>
						</div>
					))}
					{parameters.length > PARAMS_SHOWN && (
						<button className="show-more" onClick={() => setMore(!more)}>
							{more ? "Show Less" : "Show More"}
						</button>
					)}
				</Section>
			)}
			{links.size > 0 && (
				<Section title="References">
					{[...links.values()]
						.filter(l => l.url)
						.map(l => (
							<div key={l.url} className="inspector-row">
								<a href={l.url} target="_blank" rel="noreferrer noopener" className="grow">
									{l.description || l.url}
								</a>
							</div>
						))}
				</Section>
			)}
		</aside>
	)
}

function formatAngle(deg: number): string {
	return String(Math.round(deg * 1000) / 1000)
}

function paramValue(value: string): ReactNode {
	const v = value.trim()
	if (!v) return "*"
	if (/^https?:\/\/\S+$/i.test(v))
		return (
			<a href={v} target="_blank" rel="noreferrer noopener">
				{v}
			</a>
		)
	return v
}

// A part's footprint as designed (see footprint-svg.ts).
function FootprintPicture({ scene, index, label }: { scene: PcbScene; index: number; label: string }) {
	// The markup carries its own frame (the footprint's exact extent), so every part with the same
	// footprint shows the same picture.
	const markup = useMemo(() => footprintSvg(scene, index), [scene, index])
	if (!markup) return null
	return <div className="footprint-picture" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: markup }} />
}
