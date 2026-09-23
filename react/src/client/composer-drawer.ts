import type { ComposerPendingMessage } from '../../../src/interface/mod.ts';

/** Collapsed-drawer header for Astryx's `ChatComposerDrawer` (a count badge, then a label). */
export type ComposerDrawerSummary = { count: number; label: string };

/**
 * What's waiting in the composer, by kind: steering, queued, stashed, attached
 * (files and voice notes). The badge carries the total; a single kind's label is
 * just its word ("[2] queued"), a mix spells out each count ("[4] 2 queued · 1 attached · 1 stashed").
 */
export function composerDrawerSummary(args: {
	pendingMessages: readonly Pick<ComposerPendingMessage, 'kind'>[];
	attachmentCount: number;
}): ComposerDrawerSummary | null {
	const countOf = (kind: ComposerPendingMessage['kind']) =>
		args.pendingMessages.filter((message) => message.kind === kind).length;
	const parts = [
		{ word: 'steering', n: countOf('steer') },
		{ word: 'queued', n: countOf('queue') },
		{ word: 'stashed', n: countOf('stash') },
		{ word: 'attached', n: args.attachmentCount },
	].filter((part) => part.n > 0);
	const count = parts.reduce((sum, part) => sum + part.n, 0);
	if (count === 0) return null;
	const label =
		parts.length === 1 ? parts[0]!.word : parts.map((part) => `${String(part.n)} ${part.word}`).join(' · ');
	return { count, label };
}
