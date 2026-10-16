import { throwIfAborted } from '../../../guardrails/error.ts';
import type { StepWait, StepWaitOutcome } from '../../tools/stage-run.ts';
import type { TurnEvent } from '../../types.ts';

/** Why one call is held for another: its `pre_tool` asked, or one at a time puts it after. */
type WaitKind = 'asked' | 'after';

/** One step's calls: when each may start, and who waits for whom. */
export interface StepOrder {
  /** Resolves when the call may start: at once side by side, once every call before it settles one at a time. */
  start(callId: string): Promise<void>;
  /** Marks the call settled; what waits for it goes on. */
  settle(callId: string): void;
  wait: StepWait;
}

/**
 * A promise and the function that settles it. `Promise.withResolvers` would do, but the React
 * package compiles the kernel against ES2023, which lacks it.
 */
function settleable<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * The order of a step's calls. Side by side, every call starts at once. One at a time,
 * each starts when every call before it has settled. A call whose `pre_tool` answers `waitFor`
 * is held until those calls settle. A wait on a call outside the step fails; so does a wait
 * that can never end, because the call waited for waits for this one or runs after it. Every
 * call whose own wait closes such a loop fails.
 */
export function stepOrder(
  callIds: readonly string[],
  parallel: boolean,
  signal?: AbortSignal,
): StepOrder {
  const settled = new Set<string>();
  const done = new Map(callIds.map((id) => [id, settleable<void>()]));
  const waits = new Map<string, Map<string, WaitKind>>();
  const held = new Map<string, (outcome: StepWaitOutcome) => void>();
  const unhook = new Map<string, () => void>();
  const earlier = (callId: string) => (parallel ? [] : callIds.slice(0, callIds.indexOf(callId)));
  for (const id of callIds) {
    const before = earlier(id);
    if (before.length > 0) waits.set(id, new Map(before.map((target) => [target, 'after'])));
  }

  /** The calls from `from` to `to` along unsettled waits, or `undefined` when none leads there. */
  const pathTo = (from: string, to: string, seen = new Set<string>()): string[] | undefined => {
    if (from === to) return [to];
    if (seen.has(from) || settled.has(from)) return undefined;
    seen.add(from);
    for (const next of waits.get(from)?.keys() ?? []) {
      const rest = pathTo(next, to, seen);
      if (rest) return [from, ...rest];
    }
    return undefined;
  };

  const release = (id: string, outcome: StepWaitOutcome) => {
    held.get(id)?.(outcome);
    held.delete(id);
    unhook.get(id)?.();
    unhook.delete(id);
    for (const [target, kind] of waits.get(id) ?? []) {
      if (kind === 'asked') waits.get(id)?.delete(target);
    }
  };

  const doneOf = (id: string) => done.get(id)?.promise ?? Promise.resolve();

  return {
    start: async (callId) => {
      await Promise.all(earlier(callId).map(doneOf));
      throwIfAborted(signal);
    },
    settle: (callId) => {
      settled.add(callId);
      waits.delete(callId);
      done.get(callId)?.resolve();
    },
    wait: (callId, waitFor) => {
      const unknown = waitFor.filter((id) => !done.has(id));
      if (unknown.length > 0) {
        return Promise.resolve({ ok: false, reason: 'unknown', callIds: unknown });
      }
      const pending = waitFor.filter((id) => !settled.has(id));
      if (pending.length === 0) return Promise.resolve({ ok: true });
      const own = waits.get(callId) ?? new Map<string, WaitKind>();
      waits.set(callId, own);
      for (const id of pending) own.set(id, 'asked');
      const loops = pending.flatMap((id) => {
        const path = pathTo(id, callId);
        return path ? [{ id, path }] : [];
      });
      if (loops.length > 0) {
        // why: Every call whose own wait is part of the loop is held for nothing that can come; each fails.
        for (const { path } of loops) {
          for (const [index, id] of path.entries()) {
            const next = path[index + 1];
            if (next !== undefined && id !== callId && waits.get(id)?.get(next) === 'asked') {
              release(id, { ok: false, reason: 'cycle', callIds: [next] });
            }
          }
        }
        release(callId, { ok: false, reason: 'cycle', callIds: loops.map(({ id }) => id) });
        return Promise.resolve({
          ok: false,
          reason: 'cycle',
          callIds: loops.map(({ id }) => id),
        });
      }
      const outcome = settleable<StepWaitOutcome>();
      held.set(callId, outcome.resolve);
      Promise.all(pending.map(doneOf)).then(() => release(callId, { ok: true }));
      const aborted = new Promise<never>((_, reject) => {
        if (!signal) return;
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        unhook.set(callId, () => signal.removeEventListener('abort', onAbort));
      });
      // why: An aborted turn ends the wait with the abort; the call settles as aborted.
      aborted.catch(() => {});
      return Promise.race([outcome.promise, aborted]);
    },
  };
}

/** Runs a call's body once the step lets it start, and settles it however the body ends. */
export async function* inStep<T>(
  order: StepOrder,
  callId: string,
  body: () => AsyncGenerator<TurnEvent, T>,
): AsyncGenerator<TurnEvent, T> {
  try {
    await order.start(callId);
    return yield* body();
  } finally {
    order.settle(callId);
  }
}

/**
 * Runs tools side by side and passes on each event as it comes. Returns each run's
 * settlement by its place in `runs`, `undefined` where there was no run.
 *
 * why: One run that throws ends them all; the rest are closed so none keeps running unseen.
 */
export async function* runSideBySide<T>(
  runs: (AsyncGenerator<TurnEvent, T | undefined> | undefined)[],
): AsyncGenerator<TurnEvent, (T | undefined)[]> {
  const settled: (T | undefined)[] = runs.map(() => undefined);
  const waiting = new Map<
    number,
    Promise<{ index: number; next: IteratorResult<TurnEvent, T | undefined> }>
  >();
  const pull = (index: number, run: AsyncGenerator<TurnEvent, T | undefined>) => {
    const next = run.next().then((result) => ({ index, next: result }));
    // why: A run that fails after another already threw is closed below; its failure has nowhere to go.
    next.catch(() => {});
    waiting.set(index, next);
  };
  runs.forEach((run, index) => {
    if (run) pull(index, run);
  });
  try {
    while (waiting.size > 0) {
      const { index, next } = await Promise.race(waiting.values());
      waiting.delete(index);
      const run = runs[index];
      if (next.done || !run) {
        if (next.done) settled[index] = next.value;
        continue;
      }
      yield next.value;
      pull(index, run);
    }
  } finally {
    for (const index of waiting.keys()) {
      runs[index]?.return(undefined).catch(() => {});
    }
  }
  return settled;
}
