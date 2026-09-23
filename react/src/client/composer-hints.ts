/**
 * Composer hints — ephemeral guidance about the current composer interaction
 * (not pending-message state). Mirrors seance's `stash-selected-draft` hint.
 */

/** Stash shortcut in Astryx `Kbd` notation (`mod` is ⌘ on macOS, Ctrl elsewhere). */
export const STASH_SHORTCUT = 'mod+shift+s';

export type ComposerHint = {
	id: 'stash-selected-draft';
	message: string;
	actionLabel: string;
	shortcut: string;
};

/** Whether a keydown is the stash shortcut (⌘⇧S / Ctrl+Shift+S). */
export function isStashShortcut(event: {
	code: string;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
}): boolean {
	return event.code === 'KeyS' && event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey);
}

/** "Replacing this?" — shown while the whole draft is selected in the focused input and it can be stashed. */
export function resolveComposerHint(args: {
	draftText: string;
	selectedText: string;
	canStash: boolean;
}): ComposerHint | null {
	const draft = args.draftText.trim();
	if (!args.canStash || !draft || args.selectedText.trim() !== draft) return null;
	return {
		id: 'stash-selected-draft',
		message: 'Replacing this?',
		actionLabel: 'Stash it',
		shortcut: STASH_SHORTCUT,
	};
}
