import type { ComposerPendingMessage } from '../../../src/interface/mod.ts';

/** What waits in the composer, by kind; the UI words each kind. */
export type ComposerDrawerKind = 'steer' | 'queue' | 'stash' | 'attached';

/** Collapsed-drawer header: the total, then each waiting kind's count, in display order. */
export type ComposerDrawerSummary = { count: number; parts: { kind: ComposerDrawerKind; n: number }[] };

/**
 * What's waiting in the composer, by kind: steering, queued, stashed, attached
 * (files and voice notes). Null when nothing waits.
 */
export function composerDrawerSummary(args: {
	pendingMessages: readonly Pick<ComposerPendingMessage, 'kind'>[];
	attachmentCount: number;
}): ComposerDrawerSummary | null {
	const countOf = (kind: ComposerPendingMessage['kind']) =>
		args.pendingMessages.filter((message) => message.kind === kind).length;
	const parts: ComposerDrawerSummary['parts'] = [
		{ kind: 'steer' as const, n: countOf('steer') },
		{ kind: 'queue' as const, n: countOf('queue') },
		{ kind: 'stash' as const, n: countOf('stash') },
		{ kind: 'attached' as const, n: args.attachmentCount },
	].filter((part) => part.n > 0);
	const count = parts.reduce((sum, part) => sum + part.n, 0);
	return count === 0 ? null : { count, parts };
}
