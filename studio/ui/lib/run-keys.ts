import {
  createStudioRunId,
  maskedStudioRun,
  type StudioRunCredentials,
  type StudioRunPayload,
  studioRunCredentials,
  studioRunIsMasked,
} from '../../mod.ts';
import { handOffRun } from './studio-session.ts';

/** A run tab's keys: the studio's vault, by slot. */
export type RunKeys = Readonly<Record<string, string>>;

const ASK = 'theorem.studio.run-keys.ask';
const KEYS = 'theorem.studio.run-keys';
const GONE = 'theorem.studio.run-keys.gone';
/** Held by the studio page that handed a run off, for as long as it holds the run's credentials. */
const RUN_LOCK = 'theorem.studio.run-keys:';

type Ask = { type: typeof ASK; run: string };
type Reply = { type: typeof KEYS; run: string; keys: RunKeys; tools: StudioRunCredentials };
type Gone = { type: typeof GONE; run: string };

const isAsk = (data: unknown): data is Ask =>
  typeof data === 'object' &&
  data !== null &&
  (data as Ask).type === ASK &&
  typeof (data as Ask).run === 'string';

const isReply = (data: unknown): data is Reply =>
  typeof data === 'object' &&
  data !== null &&
  (data as Reply).type === KEYS &&
  typeof (data as Reply).run === 'string' &&
  typeof (data as Reply).keys === 'object' &&
  typeof (data as Reply).tools === 'object';

const isGone = (data: unknown): data is Gone =>
  typeof data === 'object' &&
  data !== null &&
  (data as Gone).type === GONE &&
  typeof (data as Gone).run === 'string';

/** A run as the browser keeps it, and whether keeping it masked credentials the run tab must ask for. */
export interface KeptRun {
  payload: StudioRunPayload;
  masked: boolean;
}

/** The runs this tab handed off, with the credentials their kept copies mask. They last as long as the page. */
const handed = new Map<string, StudioRunCredentials>();
/** The keys the studio holds now, while its screen is open. */
let heldKeys: (() => RunKeys) | undefined;
let answering = false;

/**
 * Hands `payload` to a new run tab through the browser's keep, its tools' credentials masked;
 * the run tab asks this tab for them. Resolves to the run's id, for the run tab's address, once
 * this tab holds the run's lock.
 */
export async function handOffStudioRun(payload: StudioRunPayload): Promise<string> {
  const run = createStudioRunId();
  const kept: KeptRun = { payload: maskedStudioRun(payload), masked: studioRunIsMasked(payload) };
  handed.set(run, studioRunCredentials(payload));
  answerAsks();
  handOffRun(run, JSON.stringify(kept));
  const locks = navigator.locks;
  // invariant: the run tab opens after the lock is held, so its query finds it.
  // why: Chrome refuses a lock granted while `window.open` runs, and drops the request.
  if (locks)
    await new Promise<void>((held) => {
      locks
        .request(`${RUN_LOCK}${run}`, () => {
          held();
          return new Promise<never>(() => {});
        })
        .catch(() => {
          held();
        });
    });
  return run;
}

/** Whether `source` is a window this tab opened. A window from another origin throws on `opener`. */
function openedHere(source: MessageEventSource | null): source is Window {
  try {
    return source !== null && 'opener' in source && source.opener === globalThis.window;
  } catch {
    return false;
  }
}

/**
 * Answers each run tab this page opened, for the life of the page: with the keys the screen holds
 * now and the run's tools' credentials, or that it holds them no longer.
 * invariant: keys go only to a same-origin window this tab opened, for a run id this tab handed off.
 */
function answerAsks(): void {
  if (answering) return;
  answering = true;
  globalThis.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== globalThis.location.origin || !isAsk(event.data)) return;
    if (!openedHere(event.source)) return;
    const { run } = event.data;
    const tools = handed.get(run);
    const reply: Reply | Gone =
      tools && heldKeys ? { type: KEYS, run, keys: heldKeys(), tools } : { type: GONE, run };
    event.source.postMessage(reply, globalThis.location.origin);
  });
}

/** Lends the screen's keys to the run tabs this page opened, until the returned cleanup. */
export function answerRunKeys(keys: () => RunKeys): () => void {
  heldKeys = keys;
  return () => {
    if (heldKeys === keys) heldKeys = undefined;
  };
}

/**
 * Asks the studio tab that opened this run for its keys and its tools' credentials. `onGone` when
 * that tab no longer holds them: it was closed, reloaded or left the studio. Returns null when
 * no studio tab opened this one; otherwise the cleanup.
 */
export function askRunKeys(
  run: string,
  onKeys: (keys: RunKeys, tools: StudioRunCredentials) => void,
  onGone: () => void,
): (() => void) | null {
  const studio = globalThis.window.opener as Window | null;
  if (!studio) return null;
  const receive = (event: MessageEvent) => {
    if (event.origin !== globalThis.location.origin || event.source !== studio) return;
    if (isReply(event.data) && event.data.run === run) onKeys(event.data.keys, event.data.tools);
    if (isGone(event.data) && event.data.run === run) onGone();
  };
  globalThis.addEventListener('message', receive);
  // why: a page that left or closed answers nothing; its lock on the run is gone with it.
  void navigator.locks?.query().then(({ held = [], pending = [] }) => {
    if (![...held, ...pending].some((lock) => lock.name === `${RUN_LOCK}${run}`)) onGone();
  });
  const ask: Ask = { type: ASK, run };
  try {
    studio.postMessage(ask, globalThis.location.origin);
  } catch {
    onGone();
  }
  return () => {
    globalThis.removeEventListener('message', receive);
  };
}
