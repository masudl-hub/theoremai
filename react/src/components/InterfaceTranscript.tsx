import { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptBlock } from '../../../src/interface/mod.ts';
import type { ToolCredential } from 'theorum/kernel';
import { groupTranscriptBlocks } from '../client/transcript-groups';
import { resolveScrollToBottomScrollTop } from '../client/transcript-scroll';
import { AssistantTurnView } from './AssistantTurnView';
import { TranscriptBlockView } from './TranscriptBlockView';

export type InterfaceTranscriptProps = {
	blocks: TranscriptBlock[];
	handle: string;
	streaming?: boolean;
	onBranch?: (index: number) => void;
	onToolDecision?: (
		index: number,
		action: 'allow' | 'allow_session' | 'deny',
		interactiveValue?: unknown,
	) => void;
	onAuthCredential?: (index: number, slot: string, credential: ToolCredential) => void;
};

function stickTranscriptToBottom(el: HTMLElement): void {
	el.scrollTop = resolveScrollToBottomScrollTop({
		scrollHeight: el.scrollHeight,
		clientHeight: el.clientHeight,
	});
}

export function InterfaceTranscript({
	blocks,
	handle,
	streaming = false,
	onBranch,
	onToolDecision,
	onAuthCredential,
}: InterfaceTranscriptProps) {
	const scrollElRef = useRef<HTMLDivElement | null>(null);
	const blockTimesRef = useRef(new Map<string, number>());
	const [, setBlockTimesVersion] = useState(0);

	const groups = useMemo(() => groupTranscriptBlocks(blocks), [blocks]);

	useEffect(() => {
		const t = Date.now();
		let added = false;
		for (const block of blocks) {
			if (!blockTimesRef.current.has(block.id)) {
				blockTimesRef.current.set(block.id, t);
				added = true;
			}
		}
		if (added) setBlockTimesVersion((v) => v + 1);
	}, [blocks]);

	// While streaming: pin with scrollTop (no smooth) and ResizeObserver so
	// in-place text growth stays stuck without scrollTo thrash.
	useEffect(() => {
		const el = scrollElRef.current;
		if (!el || blocks.length === 0) return;

		if (streaming) {
			const stick = () => {
				stickTranscriptToBottom(el);
			};
			stick();
			const ro = new ResizeObserver(() => {
				stick();
			});
			ro.observe(el);
			const rail = el.firstElementChild;
			if (rail instanceof HTMLElement) ro.observe(rail);
			return () => {
				ro.disconnect();
			};
		}

		requestAnimationFrame(() => {
			stickTranscriptToBottom(el);
		});
		return undefined;
	}, [blocks, streaming]);

	function blockAtId(id: string): number {
		return blockTimesRef.current.get(id) ?? Date.now();
	}

	function flatIndex(block: TranscriptBlock): number {
		return blocks.findIndex((entry) => entry.id === block.id);
	}

	return (
		<div
			ref={scrollElRef}
			className="iface-transcript"
			role="log"
			aria-live="polite"
			aria-relevant="additions"
		>
			{groups.length > 0 ? (
				<div className="iface-transcript__rail">
					<ul className="iface-transcript__list">
						{groups.map((group) => (
							<li key={group.key} className="iface-transcript__item">
								{group.kind === 'user' ? (
									group.blocks.map((block) => (
										<TranscriptBlockView
											key={block.id}
											block={block}
											handle={handle}
											at={blockAtId(block.id)}
											onBranch={
												onBranch
													? () => {
															onBranch(flatIndex(block));
														}
													: undefined
											}
											showChrome
										/>
									))
								) : (
									<AssistantTurnView
										blocks={group.blocks}
										handle={handle}
										at={blockAtId(group.blocks[0]?.id ?? group.key)}
										onAuthCredential={
											onAuthCredential
												? (block, slot, credential) => {
														onAuthCredential(flatIndex(block), slot, credential);
													}
												: undefined
										}
										onBranch={
											onBranch
												? () => {
														const last = group.blocks.at(-1);
														if (last) onBranch(flatIndex(last));
													}
												: undefined
										}
										onToolDecision={
											onToolDecision
												? (block, action, interactiveValue) => {
														onToolDecision(flatIndex(block), action, interactiveValue);
													}
												: undefined
										}
										showChrome={!(streaming && group === groups.at(-1))}
										streaming={streaming && group === groups.at(-1)}
									/>
								)}
							</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}
