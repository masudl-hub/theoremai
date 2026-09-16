/**
 * English rendering of the headless composer's semantic action keys.
 *
 * Headless interface emits keys only (`send` / `stop` / `queue` / `steer` /
 * `send_now` / `stash`); the words live here in the rendering layer, exported
 * so hosts can reuse or replace them when composing their own UI.
 */

import type { ComposerMenuAction, ComposerPrimaryAction } from '../../../src/interface/mod.ts';

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
