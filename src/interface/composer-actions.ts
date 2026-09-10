/**
 * Composer primary / menu action matrix (headless).
 *
 * Seance-aligned:
 * - idle + empty → none
 * - idle + payload → send (menu: stash)
 * - streaming + empty → stop
 * - streaming + payload → queue (menu: queue, steer?, send_now, stash)
 * - paused + empty → none (tool pause is still the same run; no abort stream)
 * - paused + payload → queue (menu: queue, send_now, stash — no steer; runner idle)
 *
 * Tool pause does **not** drain the queue. Enter matches primary (queue while
 * streaming/paused with payload). No keyboard shortcuts in this contract.
 *
 * @module
 */

import type { ComposerPendingKind } from './pending.ts';

/** Host turn phase for composer affordances. */
export type ComposerRunPhase = 'idle' | 'streaming' | 'paused';

/** Primary button / Enter target. */
export type ComposerPrimaryAction = 'send' | 'stop' | 'queue' | 'none';

/**
 * Split-menu / long-press actions. `send_now` is abort+send while streaming, or
 * abandon the tool pause (no model continue) + send while paused; not a pending kind.
 */
export type ComposerMenuAction = ComposerPendingKind | 'send_now';

export type ComposerActionContext = {
  phase: ComposerRunPhase;
  /** Draft has text and/or attachments/voice. */
  hasPayload: boolean;
  /** From `ProfileInterface.allowSteering` (text only; false elsewhere). */
  allowSteering: boolean;
  /** Composer profiles always project `canStop: true`. */
  canStop?: boolean;
};

/** Resolve the primary control (and Enter) for the current phase + draft. */
function resolveComposerPrimary(ctx: ComposerActionContext): ComposerPrimaryAction {
  const canStop = ctx.canStop !== false;
  if (ctx.phase === 'idle') {
    return ctx.hasPayload ? 'send' : 'none';
  }
  if (ctx.phase === 'streaming') {
    if (!ctx.hasPayload) return canStop ? 'stop' : 'none';
    return 'queue';
  }
  // paused — still same run; queue only, no stop stream
  return ctx.hasPayload ? 'queue' : 'none';
}

/**
 * Actions offered beside the primary control.
 * Empty when there is nothing useful to choose.
 */
function resolveComposerMenuActions(ctx: ComposerActionContext): ComposerMenuAction[] {
  if (!ctx.hasPayload) return [];

  if (ctx.phase === 'idle') {
    return ['stash'];
  }

  if (ctx.phase === 'streaming') {
    const actions: ComposerMenuAction[] = ['queue'];
    if (ctx.allowSteering) actions.push('steer');
    actions.push('send_now', 'stash');
    return actions;
  }

  // paused: no steer (runner not at a barrier); send_now = host ends wait + send
  return ['queue', 'send_now', 'stash'];
}

/** Human labels for UI (hosts may override). */
const COMPOSER_MENU_ACTION_LABELS: Record<ComposerMenuAction, string> = {
  queue: 'Queue',
  steer: 'Steer current run',
  send_now: 'Send now',
  stash: 'Stash',
};

const COMPOSER_MENU_ACTION_DESCRIPTIONS: Record<ComposerMenuAction, string> = {
  queue: 'Send after the current run finishes.',
  steer: 'Deliver at the next safe boundary.',
  send_now: 'Stop or leave the pause, then send this message.',
  stash: 'Save in the composer for later.',
};

const COMPOSER_PRIMARY_LABELS: Record<ComposerPrimaryAction, string> = {
  send: 'Send',
  stop: 'Stop',
  queue: 'Queue',
  none: 'Send',
};

export {
  COMPOSER_MENU_ACTION_DESCRIPTIONS,
  COMPOSER_MENU_ACTION_LABELS,
  COMPOSER_PRIMARY_LABELS,
  resolveComposerMenuActions,
  resolveComposerPrimary,
};
