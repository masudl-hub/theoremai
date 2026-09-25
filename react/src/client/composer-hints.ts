/**
 * Composer hints — ephemeral guidance about the current composer interaction
 * (not pending-message state). Mirrors seance's `stash-selected-draft` hint.
 */

/** Stash shortcut in Astryx `Kbd` notation (`mod` is ⌘ on macOS, Ctrl elsewhere). */
export const STASH_SHORTCUT = 'mod+shift+s';

/** Which hint applies, and its shortcut; the UI words it. */
export type ComposerHint = {
	id: 'stash-selected-draft';
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

/** The stash hint — shown while the whole draft is selected in the focused input and it can be stashed. */
export function resolveComposerHint(args: {
	draftText: string;
	selectedText: string;
	canStash: boolean;
}): ComposerHint | null {
	const draft = args.draftText.trim();
	if (!args.canStash || !draft || args.selectedText.trim() !== draft) return null;
	return {
		id: 'stash-selected-draft',
		shortcut: STASH_SHORTCUT,
	};
}
