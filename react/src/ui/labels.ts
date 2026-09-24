/**
 * The default UI's words for the headless layer's semantic keys: composer
 * actions, hints, the drawer, work status, and live state. Exported so hosts
 * can reuse or replace them when composing their own UI; failures are worded
 * by the lexicon, not here.
 *
 * @module
 */

import type { ComposerMenuAction, ComposerPrimaryAction } from '../../../src/interface/mod.ts';
import type { ComposerDrawerKind, ComposerDrawerSummary } from '../client/composer-drawer.ts';
import type { ComposerHint } from '../client/composer-hints.ts';
import type { LiveState } from '../client/live/live-state.ts';
import type { WorkStatus } from '../client/transcript-groups.ts';

export const COMPOSER_PRIMARY_LABELS: Record<ComposerPrimaryAction, string> = {
	send: 'Send',
	stop: 'Stop',
	queue: 'Queue',
	none: 'Send',
};

export const COMPOSER_MENU_ACTION_LABELS: Record<ComposerMenuAction, string> = {
	queue: 'Queue',
	steer: 'Steer current run',
	send_now: 'Send now',
	stash: 'Stash',
};

export const COMPOSER_MENU_ACTION_DESCRIPTIONS: Record<ComposerMenuAction, string> = {
	queue: 'Send after the current run finishes.',
	steer: 'Inject at the next inject-capable stage (pre_turn / post_tool / before_end).',
	send_now: 'Stop or leave the gate, then send this message.',
	stash: 'Save in the composer for later.',
};

export const COMPOSER_HINT_LABELS: Record<ComposerHint['id'], { message: string; actionLabel: string }> = {
	'stash-selected-draft': { message: 'Replacing this?', actionLabel: 'Stash it' },
};

const DRAWER_KIND_WORDS: Record<ComposerDrawerKind, string> = {
	steer: 'steering',
	queue: 'queued',
	stash: 'stashed',
	attached: 'attached',
};

/** A single kind is just its word ("queued"); a mix spells out each count ("2 queued · 1 attached"). */
export function composerDrawerLabel(summary: ComposerDrawerSummary): string {
	const [only] = summary.parts;
	if (summary.parts.length === 1 && only) return DRAWER_KIND_WORDS[only.kind];
	return summary.parts.map((part) => `${String(part.n)} ${DRAWER_KIND_WORDS[part.kind]}`).join(' · ');
}

/** Fallback name for a voice note whose format is unknown. */
export const VOICE_NOTE_LABEL = 'voice note';

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
export function workStatusLabel(status: WorkStatus | null): string {
	if (!status) return '';
	if (status.phase === 'working') {
		return status.elapsedMs === undefined ? 'Working…' : `Working for ${formatLiveDuration(status.elapsedMs)}`;
	}
	return status.elapsedMs === undefined ? 'Worked' : `Worked for ${formatWorkDuration(status.elapsedMs)}`;
}

/** A live call's status line; `calling_tool` names the tool. */
export function liveStateLabel(state: LiveState, toolName: string | null): string {
	if (state === 'calling_tool') return `calling ${toolName ?? ''}`;
	if (state === 'requesting_mic') return 'requesting mic';
	return state;
}
