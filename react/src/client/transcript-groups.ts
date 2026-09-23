/**
 * Group flat transcript blocks into user / assistant turns for message-shell UI.
 * Tools, reasoning, and mid-turn narration stay inside the assistant turn
 * (Seance-style), not as separate messages.
 */

import type { TranscriptBlock } from '../../../src/interface/mod.ts';

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
	/** Final answer segments (text / media / structured / grounding / evidence / error). */
	body: TranscriptBlock[];
	/** True when the disclosure control should appear. */
	hasTrace: boolean;
};

const USER_KINDS = new Set(['user-text', 'user-attachment', 'user-voice']);

function isUserTranscriptBlock(block: TranscriptBlock): boolean {
	return USER_KINDS.has(block.kind);
}

/** Hide bookkeeping from the message body. */
function isHiddenTranscriptBlock(block: TranscriptBlock): boolean {
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
			return 'gated';
		case 'running':
		case 'progress':
			return 'running';
		default:
			return phase ?? 'called';
	}
}

/** Wall-clock duration copy matching Seance's builder-trace formatter. */
function formatWorkDuration(durationMs: number): string {
	const ms = Math.max(0, durationMs);
	if (ms < 1_000) return `${String(Math.round(ms))}ms`;
	if (ms < 10_000) {
		const seconds = Math.round(ms / 100) / 10;
		return `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)}s`;
	}
	if (ms < 60_000) return `${String(Math.round(ms / 1_000))}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1_000);
	if (seconds === 0) return `${String(minutes)}m`;
	return `${String(minutes)}m ${String(seconds)}s`;
}

/** Whole-second ticker while a turn runs: "0s", "12s", "1m 5s". */
function formatLiveDuration(durationMs: number): string {
	const total = Math.floor(Math.max(0, durationMs) / 1_000);
	if (total < 60) return `${String(total)}s`;
	return `${String(Math.floor(total / 60))}m ${String(total % 60)}s`;
}

/** "Working for 12s" while streaming (when the start is known), "Worked for 3.2s" after. */
export function workStatusLabel(args: {
	streaming: boolean;
	hasTrace: boolean;
	elapsedMs?: number;
}): string {
	if (args.streaming) {
		return args.elapsedMs === undefined ? 'Working…' : `Working for ${formatLiveDuration(args.elapsedMs)}`;
	}
	const duration =
		args.elapsedMs !== undefined && args.elapsedMs > 0 ? formatWorkDuration(args.elapsedMs) : null;
	if (duration) return `Worked for ${duration}`;
	return args.hasTrace ? 'Worked' : '';
}

function isGatedTool(
	block: TranscriptBlock,
): block is Extract<TranscriptBlock, { kind: 'tool' }> {
	return block.kind === 'tool' && block.tool.phase === 'gate' && Boolean(block.tool.gate);
}

function lastToolIndexOf(blocks: readonly TranscriptBlock[]): number {
	for (let i = blocks.length - 1; i >= 0; i -= 1) {
		if (blocks[i]?.kind === 'tool') return i;
	}
	return -1;
}

function pushTextBlock(
	block: Extract<TranscriptBlock, { kind: 'text' }>,
	args: { hasTools: boolean; index: number; lastToolIndex: number },
	trace: TraceItem[],
	body: TranscriptBlock[],
): void {
	// Text before a tool call is narration; text after the latest one is the
	// answer, streamed in place. If another tool call follows, it becomes narration.
	if (args.hasTools && args.index < args.lastToolIndex) {
		if (block.text.trim()) {
			trace.push({ kind: 'narration', id: block.id, text: block.text });
		}
		return;
	}
	body.push(block);
}

function classifyNonGateBlock(
	block: TranscriptBlock,
	args: { hasTools: boolean; index: number; lastToolIndex: number },
	trace: TraceItem[],
	body: TranscriptBlock[],
): void {
	if (block.kind === 'thought') {
		if (block.text.trim()) {
			trace.push({ kind: 'reasoning', id: block.id, text: block.text });
		}
		return;
	}
	if (block.kind === 'tool') {
		trace.push({ kind: 'tool', id: block.id, block });
		return;
	}
	if (block.kind === 'text') {
		pushTextBlock(block, args, trace, body);
		return;
	}
	body.push(block);
}

/**
 * Split an assistant turn into Seance-style trace + final body.
 *
 * - `thought` → always reasoning in the trace
 * - non-gate `tool` → tool item in the trace
 * - gate `tool` → interactive card outside the collapsed list
 * - `text` before/between tools → narration; text and answer kinds after the
 *   latest tool → body (while streaming too, so the answer streams formatted)
 * - No tools: thoughts still go to trace; remaining kinds → body
 */
export function composeAssistantTurn(blocks: readonly TranscriptBlock[]): ComposedAssistantTurn {
	const visible = blocks.filter((block) => !isHiddenTranscriptBlock(block));
	const gatedTools = visible.filter(isGatedTool);
	const nonGate = visible.filter((block) => !isGatedTool(block));
	const lastToolIndex = lastToolIndexOf(nonGate);
	const hasTools = lastToolIndex >= 0;

	const trace: TraceItem[] = [];
	const body: TranscriptBlock[] = [];
	for (const [index, block] of nonGate.entries()) {
		classifyNonGateBlock(block, { hasTools, index, lastToolIndex }, trace, body);
	}

	return {
		trace,
		gatedTools,
		body,
		hasTrace: trace.length > 0,
	};
}
