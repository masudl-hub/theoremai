/**
 * What happened in a studio run that the builder, or an agent beside them, should know of: what
 * the project has to look at, what each provider said of its key, a run that failed, and an error
 * in the page. The last 200 are kept, so `theorem-studio errors` can read them, and a follower is
 * told each new one. A run that ends well is not one.
 *
 * @module
 */

import { createEventFeed } from './watch.ts';

/** One thing that happened. */
export interface StudioEvent {
  /** When, as an ISO time. */
  at: string;
  /** What it is about: what the project has to look at, a key, a run, or the page. */
  kind: 'look' | 'key' | 'run' | 'page';
  text: string;
  /** How many times in a row it happened, when more than once. */
  repeated?: number;
}

/** How many events the log keeps. */
export const EVENTS_KEPT = 200;

/** The longest text an event keeps, so a page cannot fill the log with one. */
const TEXT_CAP = 2000;

export interface StudioEventLog {
  /** Keeps the event and tells followers. False when it repeats the last one, which is only counted. */
  add(kind: StudioEvent['kind'], text: string): boolean;
  list(): StudioEvent[];
  /** The events as server-sent events: the ones kept, then each new one. */
  follow(headers: Record<string, string>): Response;
}

export function createEventLog(now: () => Date = () => new Date()): StudioEventLog {
  const events: StudioEvent[] = [];
  const feed = createEventFeed<StudioEvent>();
  return {
    add: (kind, said) => {
      const text = said.slice(0, TEXT_CAP);
      const last = events.at(-1);
      if (last?.kind === kind && last.text === text) {
        last.repeated = (last.repeated ?? 1) + 1;
        return false;
      }
      const event: StudioEvent = { at: now().toISOString(), kind, text };
      events.push(event);
      if (events.length > EVENTS_KEPT) events.shift();
      feed.tell(event);
      return true;
    },
    list: () => [...events],
    follow: (headers) => feed.subscribe(headers, events),
  };
}

/**
 * What a failed run said, from a line of its stream: an `error` event's detail, else its wording,
 * else its kind. Undefined for any other line.
 */
export function failureIn(line: string): string | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof event !== 'object' || event === null) return undefined;
  const { type, errorInternal, error, errorKind } = event as Record<string, unknown>;
  if (type !== 'error') return undefined;
  const said = [errorInternal, error, errorKind].find((each) => typeof each === 'string' && each);
  return typeof said === 'string' ? said : 'failed';
}

/**
 * `response` as it was, with each failure in its stream told to `failed` as it passes. Only a
 * stream of JSON lines is read; the reply reaches the page unchanged and as fast.
 */
export function watchRun(response: Response, failed: (said: string) => void): Response {
  if (!response.ok) {
    response
      .clone()
      .text()
      .then(
        (body) => failed(`answered ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`),
        () => failed(`answered ${response.status}`),
      );
    return response;
  }
  if (!response.body || !/ndjson/.test(response.headers.get('content-type') ?? '')) return response;
  const decoder = new TextDecoder();
  let rest = '';
  const read = (text: string) => {
    const lines = (rest + text).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const said = failureIn(line);
      if (said !== undefined) failed(said);
    }
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        read(decoder.decode(chunk, { stream: true }));
      },
      flush() {
        read(`${decoder.decode()}\n`);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
