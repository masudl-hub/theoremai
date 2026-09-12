/**
 * Group flat transcript blocks into user / assistant turns for message-shell UI.
 * Tools, reasoning, and mid-turn narration stay inside the assistant turn
 * (Seance-style), not as separate messages.
 */

import type { TranscriptBlock } from 'theorum/interface';

export type TranscriptTurnGroup =
	| { kind: 'user'; key: string; blocks: TranscriptBlock[] }
	| { kind: 'assistant'; key: string; blocks: TranscriptBlock[] };

export type TraceItem =
	| { kind: 'reasoning'; id: string; text: string }
	| { kind: 'narration'; id: string; text: string }
	| { kind: 'tool'; id: string; block: Extract<TranscriptBlock, { kind: 'tool' }> };

export type ComposedAssistantTurn = {
	/** Ordered reasoning / narration / tools for the disclosure. */
	trace: TraceItem[];
	/** Gate tools rendered as interactive cards outside the collapsed list. */
	gatedTools: Extract<TranscriptBlock, { kind: 'tool' }>[];
	/**
	 * @deprecated Alias of `gatedTools` for Slice 3 react rename.
	 */
	pausedTools: Extract<TranscriptBlock, { kind: 'tool' }>[];
	/** Final answer segments (text / media / structured / grounding / evidence / error). */
	body: TranscriptBlock[];
	/** True when the disclosure control should appear. */
	hasTrace: boolean;
};

const USER_KINDS = new Set(['user-text', 'user-attachment', 'user-voice']);

const BODY_KINDS = new Set(['text', 'media', 'structured', 'grounding', 'evidence', 'error']);

export function isUserTranscriptBlock(block: TranscriptBlock): boolean {
	return USER_KINDS.has(block.kind);
}

/** Hide bookkeeping from the message body. */
export function isHiddenTranscriptBlock(block: TranscriptBlock): boolean {
	return block.kind === 'turn-done';
}

export function groupTranscriptBlocks(blocks: readonly TranscriptBlock[]): TranscriptTurnGroup[] {
	const groups: TranscriptTurnGroup[] = [];

	for (const block of blocks) {
		if (isHiddenTranscriptBlock(block)) continue;
		const isUser = isUserTranscriptBlock(block);
		const last = groups.at(-1);
		if (last && last.kind === (isUser ? 'user' : 'assistant')) {
			last.blocks.push(block);
			continue;
		}
		groups.push({
			kind: isUser ? 'user' : 'assistant',
			key: block.id,
			blocks: [block],
		});
	}

	return groups;
}

export function assistantTurnTools(blocks: readonly TranscriptBlock[]): TranscriptBlock[] {
	return blocks.filter((block) => block.kind === 'tool');
}

export function assistantTurnCopyText(blocks: readonly TranscriptBlock[]): string {
	return blocks
		.filter((block) => block.kind === 'text' || block.kind === 'error')
		.map((block) => ('text' in block ? block.text : 'message' in block ? block.message : ''))
		.filter(Boolean)
		.join('\n\n');
}

export function toolPhaseLabel(phase: string | undefined): string {
	switch (phase) {
		case 'complete':
			return 'done';
		case 'error':
			return 'error';
		case 'gate':
		case 'pause':
			return 'gated';
		case 'running':
		case 'progress':
			return 'running';
		default:
			return phase ?? 'called';
	}
}

/** Wall-clock duration copy matching Seance's builder-trace formatter. */
export function formatWorkDuration(durationMs: number): string {
	const ms = Math.max(0, durationMs);
	if (ms < 1_000) {
		return `${String(Math.round(ms))}ms`;
	}
	if (ms < 10_000) {
		const seconds = Math.round(ms / 100) / 10;
		return `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)}s`;
	}
	if (ms < 60_000) {
		return `${String(Math.round(ms / 1_000))}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1_000);
	if (seconds === 0) return `${String(minutes)}m`;
	return `${String(minutes)}m ${String(seconds)}s`;
}

export function workStatusLabel(args: {
	streaming: boolean;
	hasTrace: boolean;
	elapsedMs?: number;
}): string {
	if (args.streaming) return 'Working…';
	if (!args.hasTrace && (args.elapsedMs === undefined || args.elapsedMs <= 0)) return '';
	const duration =
		args.elapsedMs !== undefined && args.elapsedMs > 0 ? formatWorkDuration(args.elapsedMs) : null;
	if (!duration) return args.hasTrace ? 'Worked' : '';
	return `Worked for ${duration}`;
}

/**
 * Split an assistant turn into Seance-style trace + final body.
 *
 * - `thought` → always reasoning in the trace
 * - non-gate `tool` → tool item in the trace
 * - gate `tool` → interactive card outside the collapsed list
 * - While streaming: all `text` → narration (final markdown hidden to avoid double)
 * - When done: `text` before/between tools → narration; trailing answer kinds → body
 * - No tools: thoughts still go to trace; remaining kinds → body
 */
export function composeAssistantTurn(
	blocks: readonly TranscriptBlock[],
	args: { streaming?: boolean } = {},
): ComposedAssistantTurn {
	const streaming = args.streaming === true;
	const visible = blocks.filter((block) => !isHiddenTranscriptBlock(block));
	const gatedTools = visible.filter(
		(block): block is Extract<TranscriptBlock, { kind: 'tool' }> =>
			block.kind === 'tool' &&
			((block.tool.phase === 'gate' && Boolean(block.tool.gate)) ||
				(block.tool.phase === 'pause' && Boolean(block.tool.pause))),
	);
	const nonGate = visible.filter(
		(block) =>
			!(
				block.kind === 'tool' &&
				((block.tool.phase === 'gate' && Boolean(block.tool.gate)) ||
					(block.tool.phase === 'pause' && Boolean(block.tool.pause)))
			),
	);

	const lastToolIndex = (() => {
		for (let i = nonGate.length - 1; i >= 0; i -= 1) {
			if (nonGate[i]?.kind === 'tool') return i;
		}
		return -1;
	})();
	const hasTools = lastToolIndex >= 0;

	const trace: TraceItem[] = [];
	const body: TranscriptBlock[] = [];

	for (const [i, block] of nonGate.entries()) {
		if (block.kind === 'thought') {
			if (block.text.trim()) {
				trace.push({ kind: 'reasoning', id: block.id, text: block.text });
			}
			continue;
		}

		if (block.kind === 'tool') {
			trace.push({ kind: 'tool', id: block.id, block });
			continue;
		}

		if (block.kind === 'text') {
			// Streaming with tools: all text is mid-turn narration (final body hidden).
			// Completed: text strictly before the last tool is narration; trailing text is body.
			const isNarration = (streaming && hasTools) || (!streaming && hasTools && i < lastToolIndex);
			if (isNarration) {
				if (block.text.trim()) {
					trace.push({ kind: 'narration', id: block.id, text: block.text });
				}
				continue;
			}
			body.push(block);
			continue;
		}

		if (BODY_KINDS.has(block.kind)) {
			// While streaming with tools mid-flight, defer non-error body until the
			// turn settles so mid-turn media doesn't flash as the "final" answer.
			if (streaming && hasTools && block.kind !== 'error') {
				continue;
			}
			body.push(block);
			continue;
		}

		body.push(block);
	}

	return {
		trace,
		gatedTools,
		pausedTools: gatedTools,
		body,
		hasTrace: trace.length > 0,
	};
}
