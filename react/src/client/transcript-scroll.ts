/**
 * Transcript scroll geometry — pure helpers.
 */

export type TranscriptScrollBehavior = ScrollBehavior;

export function resolveScrollToBottomScrollTop(args: {
	scrollHeight: number;
	clientHeight: number;
}): number {
	return Math.max(0, args.scrollHeight - args.clientHeight);
}

/** Content Y such that `anchorBottom` lands on the viewport top (after padding). */
export function resolvePinBottomToTopScrollTop(args: {
	anchorBottom: number;
	paddingTop?: number;
}): number {
	return Math.max(0, args.anchorBottom - (args.paddingTop ?? 0));
}

/** Runway height so a trailing message can be scrolled up to the viewport top. */
export function resolveTranscriptRunwayHeight(args: {
	clientHeight: number;
	/** Keep a little of the prior turn visible above the pin line. */
	reserveTopPx?: number;
}): number {
	const reserve = Math.max(0, args.reserveTopPx ?? 0);
	return Math.max(0, args.clientHeight - reserve);
}

export function contentYFromViewport(args: {
	viewportTop: number;
	viewportY: number;
	scrollTop: number;
}): number {
	return args.viewportY - args.viewportTop + args.scrollTop;
}

const USER_KINDS = new Set(['user-text', 'user-attachment', 'user-voice']);

export function isTranscriptUserBlockKind(kind: string): boolean {
	return USER_KINDS.has(kind);
}

/**
 * Index of the last block in the most recent user turn (contiguous user blocks
 * ending at or before trailing assistant content).
 */
export function findLastUserTurnEndIndex(blocks: ReadonlyArray<{ kind: string }>): number | null {
	for (let i = blocks.length - 1; i >= 0; i -= 1) {
		const block = blocks.at(i);
		if (!block) continue;
		if (isTranscriptUserBlockKind(block.kind)) return i;
	}
	return null;
}
