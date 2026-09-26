/**
 * Group flat transcript blocks into user / assistant turns for message-shell UI.
 * Tools, reasoning, and mid-turn narration stay inside the assistant turn
 * (Seance-style), not as separate messages.
 */

import type { TranscriptBlock } from '../../../src/interface/mod.ts';

export type TranscriptTurnGroup =
	| { kind: 'user'; key: string; blocks: TranscriptBlock[] }
	| {
			kind: 'assistant';
			key: string;
			blocks: TranscriptBlock[];
			/** The reply's work and when it stopped, from its latest stamped `turn-done`. */
			workedMs?: number;
			endedAt?: number;
	  };

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
		if (block.kind === 'turn-done') {
			const last = groups.at(-1);
			if (last?.kind === 'assistant' && block.workedMs !== undefined) {
				last.workedMs = block.workedMs;
				last.endedAt = block.endedAt;
			}
		}
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

/** A reply's text to copy; a failure is the message's status, not part of the reply. */
export function assistantTurnCopyText(blocks: readonly TranscriptBlock[]): string {
	return blocks
		.filter((block) => block.kind === 'text')
		.map((block) => block.text)
		.filter(Boolean)
		.join('\n\n');
}

/** A turn's work, for the status line: running, or done (with its duration when known). */
export type WorkStatus = { phase: 'working' | 'worked'; elapsedMs?: number };

/** Working while streaming; worked after, when it has a duration or a trace; else nothing to show. */
export function workStatus(args: {
	streaming: boolean;
	hasTrace: boolean;
	elapsedMs?: number;
}): WorkStatus | null {
	const elapsed = args.elapsedMs !== undefined ? { elapsedMs: args.elapsedMs } : {};
	if (args.streaming) return { phase: 'working', ...elapsed };
	if (args.elapsedMs !== undefined && args.elapsedMs > 0) return { phase: 'worked', elapsedMs: args.elapsedMs };
	return args.hasTrace ? { phase: 'worked' } : null;
}

function isGatedTool(
	block: TranscriptBlock,
): block is Extract<TranscriptBlock, { kind: 'tool' }> {
	return block.kind === 'tool' && block.tool.state?.phase === 'gate';
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
 * - first gate `tool` → interactive card outside the collapsed list; later gates → trace
 * - `text` before/between tools → narration; text and answer kinds after the
 *   latest tool → body (while streaming too, so the answer streams formatted)
 * - No tools: thoughts still go to trace; remaining kinds → body
 */
export function composeAssistantTurn(blocks: readonly TranscriptBlock[]): ComposedAssistantTurn {
	const visible = blocks.filter((block) => !isHiddenTranscriptBlock(block));
	// One card at a time: the gate answered next. The step's later gates wait in the trace.
	const nextGate = visible.find(isGatedTool);
	const gatedTools = nextGate ? [nextGate] : [];
	const nonGate = visible.filter((block) => block !== nextGate);
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

/** The trailing user group while its reply has not started streaming back. */
export function pendingPromptOf(groups: readonly TranscriptTurnGroup[]): TranscriptTurnGroup | undefined {
	const last = groups.at(-1);
	return last?.kind === 'user' ? last : undefined;
}

export type AssistantTurnTiming = {
	/**
	 * Keyed by its prompt, not its blocks: the reply stays mounted from the
	 * "Working…" placeholder through streaming and commit (which re-keys blocks).
	 */
	key: string;
	live: boolean;
	/** While live: when the reply started, its approval waits skipped. */
	startedAt?: number;
	/** Once stopped: how long it worked and when it stopped, as its blocks record. */
	workedMs?: number;
	endedAt?: number;
};

/**
 * A turn sent in this session, keyed by its prompt: when it last stopped, and
 * how long it sat paused on approvals, which doesn't count as work.
 */
export type TurnSpan = { endedAt?: number; pausedMs: number };

/**
 * The key of the assistant group at `index`: its prompt's, so the reply keeps
 * one identity from "Working…" through commit. Block ids restart every reply.
 */
export function replyKey(groups: readonly TranscriptTurnGroup[], index: number): string {
	const prompt = groups[index - 1];
	return prompt?.kind === 'user' ? promptReplyKey(prompt) : (groups[index]?.key ?? String(index));
}

/** The key of the reply to `prompt`, before and after it streams. */
export function promptReplyKey(prompt: TranscriptTurnGroup): string {
	return `${prompt.key}:reply`;
}

/**
 * Key and timing for the assistant group at `index`. A stopped reply reads its
 * time from its blocks; a live one counts from its span in this session.
 */
export function assistantTurnTiming(args: {
	groups: readonly TranscriptTurnGroup[];
	index: number;
	streaming: boolean;
	timeOf: (key: string) => number;
	spans: ReadonlyMap<string, TurnSpan>;
}): AssistantTurnTiming {
	const key = replyKey(args.groups, args.index);
	const live = args.streaming && args.index === args.groups.length - 1;
	const group = args.groups[args.index];
	if (!live) {
		return group?.kind === 'assistant' && group.workedMs !== undefined
			? { key, live, workedMs: group.workedMs, endedAt: group.endedAt }
			: { key, live };
	}
	const prompt = args.groups[args.index - 1];
	const span = prompt?.kind === 'user' ? args.spans.get(prompt.key) : undefined;
	if (!prompt || !span) return { key, live };
	return { key, live, startedAt: args.timeOf(prompt.key) + span.pausedMs };
}
