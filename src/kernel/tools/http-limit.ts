import {
  retryAfterMs,
  WAIT_BUDGET_MS,
  type Wait,
  waitDefault,
} from '../../providers/shared/retry.ts';
import type { HttpToolLimit } from './types.ts';

/** Time as the limit reads it; a test passes its own. */
export interface LimitClock {
  now: () => number;
  wait: Wait;
}

const SYSTEM_CLOCK: LimitClock = { now: Date.now, wait: waitDefault };

/** One request's place in the window: unanswered it holds the place; answered, it frees it a window later. */
interface Place {
  opensAt: number;
}

/** One tool's places, when its service asked it to wait until, and the takers waiting for a place. */
interface ToolWindow {
  places: Place[];
  heldUntil: number;
  waiting: Set<() => void>;
}

/** Keyed by the registered tool, so a scope's tool has its own window and nothing is looked up by name. */
const windows = new WeakMap<object, ToolWindow>();

/** A place taken for one request. `answered` gives the service's reply, or nothing when the send threw. */
export interface LimitPlace {
  answered: (response?: Response) => void;
}

/** No place opens within a call's wait budget: when the next one opens, or `undefined` while every request is unanswered. */
export interface LimitFull {
  full: true;
  limit: HttpToolLimit;
  opensInMs: number | undefined;
}

function windowOf(tool: object): ToolWindow {
  const known = windows.get(tool);
  if (known) return known;
  const fresh: ToolWindow = { places: [], heldUntil: 0, waiting: new Set() };
  windows.set(tool, fresh);
  return fresh;
}

/** The first moment a place is free, `Infinity` while every place's request is unanswered. */
function nextOpening(window: ToolWindow, limit: HttpToolLimit, now: number): number {
  window.places = window.places.filter((place) => place.opensAt > now);
  const freeAt =
    window.places.length < limit.requests
      ? now
      : Math.min(...window.places.map((place) => place.opensAt));
  return Math.max(freeAt, window.heldUntil);
}

/** Returns when a place frees early (an answer) or the wait ends; the caller's abort rejects. */
async function waitForChange(
  window: ToolWindow,
  ms: number,
  signal: AbortSignal | null | undefined,
  clock: LimitClock,
): Promise<void> {
  const changed = new AbortController();
  const wake = (): void => changed.abort();
  window.waiting.add(wake);
  try {
    await clock.wait(ms, signal ? AbortSignal.any([signal, changed.signal]) : changed.signal);
  } catch (err) {
    if (signal?.aborted || !changed.signal.aborted) throw err;
  } finally {
    window.waiting.delete(wake);
  }
}

/**
 * Takes a place in the tool's window for one request. A request holds its place from send
 * until a window after its answer, so requests the network delivers unevenly still land
 * within the limit. A 429 with `Retry-After` holds every request of the tool until then.
 * A call waits for a place at most the same five seconds a retry may wait; past that it
 * gets `LimitFull` and sends nothing. A call is one place, its retries and redirects included.
 */
export async function takeLimitPlace(
  tool: object,
  limit: HttpToolLimit,
  signal?: AbortSignal | null,
  clock: LimitClock = SYSTEM_CLOCK,
): Promise<LimitPlace | LimitFull> {
  const window = windowOf(tool);
  const deadline = clock.now() + WAIT_BUDGET_MS;
  for (;;) {
    const now = clock.now();
    const opening = nextOpening(window, limit, now);
    if (opening <= now) {
      const place: Place = { opensAt: Number.POSITIVE_INFINITY };
      window.places.push(place);
      return {
        answered: (response) => {
          const at = clock.now();
          place.opensAt = at + limit.windowMs;
          const after = response?.status === 429 ? retryAfterMs(response.headers, at) : undefined;
          if (after !== undefined) {
            window.heldUntil = Math.max(window.heldUntil, at + after);
          }
          for (const wake of window.waiting) wake();
        },
      };
    }
    if (opening > deadline && opening !== Number.POSITIVE_INFINITY) {
      return { full: true, limit, opensInMs: opening - now };
    }
    if (now >= deadline) return { full: true, limit, opensInMs: undefined };
    await waitForChange(window, Math.min(opening, deadline) - now, signal, clock);
  }
}

/** The request sent in a place; its answer, or its failure, frees the place. */
export async function answeredIn(
  place: LimitPlace | undefined,
  sending: Promise<Response>,
): Promise<Response> {
  try {
    const response = await sending;
    place?.answered(response);
    return response;
  } catch (err) {
    place?.answered();
    throw err;
  }
}
