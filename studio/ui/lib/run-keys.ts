import { loadStudioRunPayload } from '../../mod.ts';

/** A run tab's keys: the studio's vault, by slot. */
export type RunKeys = Readonly<Record<string, string>>;

const ASK = 'theorem.studio.run-keys.ask';
const KEYS = 'theorem.studio.run-keys';

type Ask = { type: typeof ASK; run: string };
type Reply = { type: typeof KEYS; run: string; keys: RunKeys };

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
  typeof (data as Reply).keys === 'object';

/** Whether `source` is a window this tab opened. A window from another origin throws on `opener`. */
function openedHere(source: MessageEventSource | null): source is Window {
  try {
    return source !== null && 'opener' in source && source.opener === globalThis.window;
  } catch {
    return false;
  }
}

/**
 * Answers each run tab this studio tab opened with the keys it holds now.
 * invariant: keys go only to a same-origin window this tab opened, for a run id this browser saved.
 */
export function answerRunKeys(keys: () => RunKeys): () => void {
  const answer = (event: MessageEvent) => {
    if (event.origin !== globalThis.location.origin || !isAsk(event.data)) return;
    if (!openedHere(event.source) || !loadStudioRunPayload(event.data.run)) return;
    const reply: Reply = { type: KEYS, run: event.data.run, keys: keys() };
    event.source.postMessage(reply, globalThis.location.origin);
  };
  globalThis.addEventListener('message', answer);
  return () => {
    globalThis.removeEventListener('message', answer);
  };
}

/**
 * Asks the studio tab that opened this run for its keys. Returns null when no studio tab is
 * there to ask; otherwise the cleanup.
 */
export function askRunKeys(run: string, onKeys: (keys: RunKeys) => void): (() => void) | null {
  const studio = globalThis.window.opener as Window | null;
  if (!studio) return null;
  const receive = (event: MessageEvent) => {
    if (event.origin !== globalThis.location.origin || event.source !== studio) return;
    if (isReply(event.data) && event.data.run === run) onKeys(event.data.keys);
  };
  globalThis.addEventListener('message', receive);
  const ask: Ask = { type: ASK, run };
  studio.postMessage(ask, globalThis.location.origin);
  return () => {
    globalThis.removeEventListener('message', receive);
  };
}
