import type { ComposerMenuAction } from '@theoremjs/agents/interface';

/**
 * Composer hints — ephemeral guidance about the current composer interaction
 * (not pending-message state). Mirrors seance's `stash-selected-draft` hint.
 */

/**
 * Each send-menu action's key, in Astryx `Kbd` notation (`mod` is ⌘ on macOS, Ctrl elsewhere).
 * `queue` is Enter: the composer's primary action while a reply runs.
 */
export const COMPOSER_SHORTCUTS: Readonly<Record<ComposerMenuAction, string>> = {
  queue: 'enter',
  steer: 'mod+enter',
  send_now: 'mod+shift+enter',
  stash: 'mod+shift+s',
};

/**
 * The send-menu action a keydown asks for: ⌘↵ steers, ⌘⇧↵ sends now, ⌘⇧S stashes (Ctrl
 * elsewhere). `null` for any other key, plain Enter included: the field sends or queues that.
 */
export function composerShortcut(event: {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): Exclude<ComposerMenuAction, 'queue'> | null {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return null;
  if (event.key === 'Enter') return event.shiftKey ? 'send_now' : 'steer';
  if (event.code === 'KeyS' && event.shiftKey) return 'stash';
  return null;
}

/** Which hint applies, and its shortcut; the UI words it. */
export type ComposerHint = {
  id: 'stash-selected-draft';
  shortcut: string;
};

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
    shortcut: COMPOSER_SHORTCUTS.stash,
  };
}
