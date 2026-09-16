import { useState } from 'react';
import type { TraceItem } from '../client/transcript-groups';
import { toolPhaseLabel } from '../client/transcript-groups';

export type ToolTraceDisclosureProps = {
	items: TraceItem[];
	expanded?: boolean;
	streaming?: boolean;
	label: string;
	onToggle: () => void;
};

function formatPayload(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function ToolPhaseMark({ phase }: { phase: string }) {
	const mark = phase === 'complete' ? '✓' : phase === 'error' ? '×' : '·';
	return (
		<span className="iface-trace__tool-mark" aria-hidden="true">
			{mark}
		</span>
	);
}

function ToolTraceExchange({
	tool,
	open,
}: {
	tool: Extract<import('../../../src/interface/mod.ts').TranscriptBlock, { kind: 'tool' }>['tool'];
	open: boolean;
}) {
	return (
		<div
			className={
				open
					? 'iface-trace__exchange iface-trace__exchange--open'
					: 'iface-trace__exchange'
			}
			aria-hidden={!open}
			inert={!open || undefined}
		>
			<div className="iface-trace__exchange-clip">
				{tool.arguments !== undefined ? (
					<section className="iface-trace__pane">
						<p className="iface-trace__pane-label">Arguments</p>
						<pre className="iface-trace__code">
							{formatPayload(tool.arguments)}
						</pre>
					</section>
				) : null}
				{tool.output !== undefined ? (
					<section className="iface-trace__pane">
						<p className="iface-trace__pane-label">Response</p>
						<pre className="iface-trace__code">
							{formatPayload(tool.output)}
						</pre>
					</section>
				) : tool.failure !== undefined ? (
					<section className="iface-trace__pane">
						<p className="iface-trace__pane-label">Error</p>
						<pre className="iface-trace__code iface-trace__code--error">
							{formatPayload(tool.failure)}
						</pre>
					</section>
				) : null}
			</div>
		</div>
	);
}

function TraceItemView({
	item,
	open,
	onToggleTool,
}: {
	item: TraceItem;
	open: boolean;
	onToggleTool: (id: string) => void;
}) {
	if (item.kind === 'reasoning') {
		return (
			<li className="iface-trace__item iface-trace__item--reasoning">
				<p className="iface-trace__pane-label">Reasoning</p>
				<p className="iface-trace__prose">{item.text}</p>
			</li>
		);
	}
	if (item.kind === 'narration') {
		return (
			<li className="iface-trace__item iface-trace__item--narration">
				<p className="iface-trace__pane-label">Narration</p>
				<p className="iface-trace__prose">{item.text}</p>
			</li>
		);
	}

	const toolBlock = item.block;
	return (
		<li className="iface-trace__item">
			<button
				type="button"
				className="iface-trace__tool"
				aria-expanded={open}
				onClick={() => {
					onToggleTool(item.id);
				}}
			>
				<ToolPhaseMark phase={toolBlock.tool.phase} />
				<span className="iface-trace__tool-name">{toolBlock.tool.name}</span>
				<span className="iface-trace__tool-phase">
					{toolPhaseLabel(toolBlock.tool.phase)}
				</span>
			</button>
			<ToolTraceExchange tool={toolBlock.tool} open={open} />
		</li>
	);
}

function ToolTraceHeader({
	label,
	canExpand,
	showExpanded,
	onToggle,
}: {
	label: string;
	canExpand: boolean;
	showExpanded: boolean;
	onToggle: () => void;
}) {
	if (!canExpand) {
		return (
			<p className="iface-trace__status iface-trace__status--static">
				<span className="iface-trace__status-label">{label}</span>
			</p>
		);
	}
	return (
		<button
			type="button"
			className="iface-trace__status"
			aria-expanded={showExpanded}
			onClick={onToggle}
		>
			<span className="iface-trace__status-label">{label}</span>
			<span
				className={
					showExpanded
						? 'iface-trace__chevron iface-trace__chevron--open'
						: 'iface-trace__chevron'
				}
				aria-hidden="true"
			>
				›
			</span>
		</button>
	);
}

export function ToolTraceDisclosure({
	items,
	expanded = false,
	streaming = false,
	label,
	onToggle,
}: ToolTraceDisclosureProps) {
	const [openToolIds, setOpenToolIds] = useState<Partial<Record<string, boolean>>>({});
	const showExpanded = expanded || streaming;
	const canExpand = items.length > 0;

	function toggleTool(id: string) {
		setOpenToolIds((prev) => ({ ...prev, [id]: !prev[id] }));
	}

	if (!label) return null;

	return (
		<div className="iface-trace">
			<ToolTraceHeader
				label={label}
				canExpand={canExpand}
				showExpanded={showExpanded}
				onToggle={onToggle}
			/>

			{canExpand ? (
				<div
					className={
						showExpanded
							? 'iface-trace__disclosure iface-trace__disclosure--open'
							: 'iface-trace__disclosure'
					}
					aria-hidden={!showExpanded}
					inert={!showExpanded || undefined}
				>
					<div className="iface-trace__disclosure-clip">
						<ul className="iface-trace__list">
							{items.map((item) => (
								<TraceItemView
									key={item.id}
									item={item}
									open={openToolIds[item.id] ?? false}
									onToggleTool={toggleTool}
								/>
							))}
						</ul>
					</div>
				</div>
			) : null}
		</div>
	);
}
