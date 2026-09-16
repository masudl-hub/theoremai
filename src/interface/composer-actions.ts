/**
 * Composer primary / menu action matrix (headless).
 *
 * Seance-aligned:
 * - idle + empty → none
 * - idle + payload → send (menu: stash)
 * - streaming + empty → stop
 * - streaming + payload → queue (menu: queue, steer?, send_now, stash)
 * - gated + empty → none (pre_tool gate suspension; no abort stream)
 * - gated + payload → queue (menu: queue, send_now, stash — no steer)
 *
 * Tool gate does **not** drain the queue. Enter matches primary (queue while
 * streaming/gated with payload). No keyboard shortcuts in this contract.
 *
 * @module
 */

import type { ComposerPendingKind } from './pending.ts';

/** Host turn phase for composer affordances. */
export type ComposerRunPhase = 'idle' | 'streaming' | 'gated';

/** Primary button / Enter target. */
export type ComposerPrimaryAction = 'send' | 'stop' | 'queue' | 'none';

/**
 * Split-menu / long-press actions. `send_now` is abort+send while streaming, or
 * abandon the tool gate (no model continue) + send while gated; not a pending kind.
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
  // gated — still same run; queue only, no stop stream
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

  // gated: no steer (not an inject stage); send_now = host ends wait + send
  return ['queue', 'send_now', 'stash'];
}

// Headless contract: this module emits semantic action keys only. English
// labels for these keys live in the rendering layer (`@theorum/react`)
// or in the host UI.
export { resolveComposerMenuActions, resolveComposerPrimary };
