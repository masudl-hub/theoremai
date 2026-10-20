import type { ComposerPendingKind } from './pending.ts';

/** Where a run is: idle, streaming, or held at a tool gate. */
export type ComposerRunPhase = 'idle' | 'streaming' | 'gated';

/** Primary button / Enter target. */
export type ComposerPrimaryAction = 'send' | 'stop' | 'queue' | 'none';

/**
 * Split-menu / long-press actions. `send_now` is abort+send while streaming, or
 * abandon the tool gate (no model continue) + send while gated; not a pending kind.
 */
export type ComposerMenuAction = ComposerPendingKind | 'send_now';

/** What decides the composer's actions: the run phase, whether there is something to send, and whether steering and stop are allowed. */
export type ComposerActionContext = {
  phase: ComposerRunPhase;
  hasPayload: boolean;
  /** From `ProfileInterface.allowSteering` (text only; false elsewhere). */
  allowSteering: boolean;
  /** Composer profiles always project `canStop: true`. */
  canStop?: boolean;
};

/** The action of the primary button and Enter: `send` when idle with a draft, `queue` mid-run with one, `stop` while streaming with none (when stop is allowed), else `none`. */
function resolveComposerPrimary(ctx: ComposerActionContext): ComposerPrimaryAction {
  const canStop = ctx.canStop !== false;
  if (ctx.phase === 'idle') {
    return ctx.hasPayload ? 'send' : 'none';
  }
  if (ctx.phase === 'streaming') {
    if (!ctx.hasPayload) return canStop ? 'stop' : 'none';
    return 'queue';
  }
  // why: Gated is still the same run: queue only, no stream to stop.
  return ctx.hasPayload ? 'queue' : 'none';
}

/** The split menu's actions: none without a draft; `stash` when idle; mid-run `queue`, `steer` while streaming when steering is allowed, `send_now` and `stash`. */
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

  // why: gated: no steer (not an inject stage); send_now = host ends wait + send
  return ['queue', 'send_now', 'stash'];
}

// invariant: Emits semantic action keys only: English labels live in the rendering layer or the host UI.
export { resolveComposerMenuActions, resolveComposerPrimary };
