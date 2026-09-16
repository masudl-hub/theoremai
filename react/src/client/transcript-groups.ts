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

const BODY_KINDS = new Set(['text', 'media', 'structured', 'grounding', 'evidence', 'error']);

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

export function workStatusLabel(args: {
	streaming: boolean;
	hasTrace: boolean;
	elapsedMs?: number;
}): string {
	if (args.streaming) return 'Working…';
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
	args: { streaming: boolean; hasTools: boolean; index: number; lastToolIndex: number },
	trace: TraceItem[],
	body: TranscriptBlock[],
): void {
	const isNarration =
		(args.streaming && args.hasTools) ||
		(!args.streaming && args.hasTools && args.index < args.lastToolIndex);
	if (isNarration) {
		if (block.text.trim()) {
			trace.push({ kind: 'narration', id: block.id, text: block.text });
		}
		return;
	}
	body.push(block);
}

function classifyNonGateBlock(
	block: TranscriptBlock,
	args: { streaming: boolean; hasTools: boolean; index: number; lastToolIndex: number },
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
	pushBodyKind(block, args, body);
}

function pushBodyKind(
	block: TranscriptBlock,
	args: { streaming: boolean; hasTools: boolean },
	body: TranscriptBlock[],
): void {
	if (BODY_KINDS.has(block.kind)) {
		if (args.streaming && args.hasTools && block.kind !== 'error') return;
		body.push(block);
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
	const gatedTools = visible.filter(isGatedTool);
	const nonGate = visible.filter((block) => !isGatedTool(block));
	const lastToolIndex = lastToolIndexOf(nonGate);
	const hasTools = lastToolIndex >= 0;

	const trace: TraceItem[] = [];
	const body: TranscriptBlock[] = [];
	for (const [index, block] of nonGate.entries()) {
		classifyNonGateBlock(block, { streaming, hasTools, index, lastToolIndex }, trace, body);
	}

	return {
		trace,
		gatedTools,
		body,
		hasTrace: trace.length > 0,
	};
}
