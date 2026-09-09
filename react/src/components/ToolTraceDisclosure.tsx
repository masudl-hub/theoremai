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

	function toolExpanded(id: string): boolean {
		return openToolIds[id] ?? false;
	}

	function toggleTool(id: string) {
		setOpenToolIds((prev) => ({ ...prev, [id]: !prev[id] }));
	}

	if (!label) return null;

	return (
		<div className="iface-trace">
			{canExpand ? (
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
			) : (
				<p className="iface-trace__status iface-trace__status--static">
					<span className="iface-trace__status-label">{label}</span>
				</p>
			)}

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
							{items.map((item) => {
								if (item.kind === 'reasoning') {
									return (
										<li key={item.id} className="iface-trace__item iface-trace__item--reasoning">
											<p className="iface-trace__pane-label">Reasoning</p>
											<p className="iface-trace__prose">{item.text}</p>
										</li>
									);
								}
								if (item.kind === 'narration') {
									return (
										<li key={item.id} className="iface-trace__item iface-trace__item--narration">
											<p className="iface-trace__pane-label">Narration</p>
											<p className="iface-trace__prose">{item.text}</p>
										</li>
									);
								}

								const toolBlock = item.block;
								const open = toolExpanded(item.id);
								return (
									<li key={item.id} className="iface-trace__item">
										<button
											type="button"
											className="iface-trace__tool"
											aria-expanded={open}
											onClick={() => {
												toggleTool(item.id);
											}}
										>
											<span className="iface-trace__tool-mark" aria-hidden="true">
												{toolBlock.tool.phase === 'complete'
													? '✓'
													: toolBlock.tool.phase === 'error'
														? '×'
														: '·'}
											</span>
											<span className="iface-trace__tool-name">{toolBlock.tool.name}</span>
											<span className="iface-trace__tool-phase">
												{toolPhaseLabel(toolBlock.tool.phase)}
											</span>
										</button>
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
												{toolBlock.tool.arguments !== undefined ? (
													<section className="iface-trace__pane">
														<p className="iface-trace__pane-label">Arguments</p>
														<pre className="iface-trace__code">
															{formatPayload(toolBlock.tool.arguments)}
														</pre>
													</section>
												) : null}
												{toolBlock.tool.output !== undefined ? (
													<section className="iface-trace__pane">
														<p className="iface-trace__pane-label">Response</p>
														<pre className="iface-trace__code">
															{formatPayload(toolBlock.tool.output)}
														</pre>
													</section>
												) : toolBlock.tool.failure !== undefined ? (
													<section className="iface-trace__pane">
														<p className="iface-trace__pane-label">Error</p>
														<pre className="iface-trace__code iface-trace__code--error">
															{formatPayload(toolBlock.tool.failure)}
														</pre>
													</section>
												) : null}
											</div>
										</div>
									</li>
								);
							})}
						</ul>
					</div>
				</div>
			) : null}
		</div>
	);
}
