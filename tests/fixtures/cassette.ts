/**
 * Recorded provider traffic, replayed through the real adapters and kernel.
 * A guardrail change is tested against what real models sent without calling
 * them again; only a change to what Theorem sends needs new recordings, and
 * replay names the cases it touches.
 *
 * Recording sits on the transports a host can supply (`fetch`, `openWebSocket`),
 * so keys never reach a cassette: headers are not kept, and a `key` query
 * parameter is dropped from URLs.
 */

/** One HTTP call: what went out, and the response body as the chunks it arrived in. */
export interface RecordedExchange {
  method: string;
  url: string;
  body: string;
  status: number;
  contentType: string | null;
  chunks: string[];
  /** The body stopped before it ended (a dropped connection); replay ends it the same way. */
  truncated?: boolean;
}

/** Live socket traffic in the order it happened. */
export type LiveFrame =
  | { sent: string }
  | { received: string }
  | { closed: { code: number; reason: string } };

export interface Cassette {
  model: string;
  case: string;
  /**
   * Every 16-byte random draw, in order: the canary, and trace ids beside it.
   * Replay draws the same, so the model's reply leaks in any encoding it used.
   */
  draws: string[];
  exchanges: RecordedExchange[];
  frames?: LiveFrame[];
  /** What the turn did with the traffic when recorded; replay compares against it. */
  outcome: CaseOutcome;
}

/** What a case produced, as the host saw it. */
export interface CaseOutcome {
  /** Guardrail events by `stage action rule`, in order. */
  guardrails: string[];
  /** The error that ended the turn, if one did: its kind only. */
  error: string | null;
  /** Everything a host would show: reply text and thoughts. */
  shown: string;
  /** Tool calls the kernel ran, by name. */
  toolsRun: string[];
  /** What the case's mocked remote saw: an email sent, a private address fetched. */
  effects: string[];
}

/** Where a replay departed from its recording. Any entry means the case needs recording again. */
export interface ReplayDrift {
  stale: string[];
}

const CANARY_BYTES = 16;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function scrubUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('key');
  return parsed.toString();
}

/**
 * Run `body` with `crypto.getRandomValues` routed through `fill` for 16-byte
 * draws, the size of a canary; everything else draws as usual.
 */
async function withCanaryDraws<T>(
  fill: (bytes: Uint8Array, real: (bytes: Uint8Array) => void) => void,
  body: () => Promise<T>,
): Promise<T> {
  const real = crypto.getRandomValues.bind(crypto);
  const draw = (bytes: Uint8Array) => {
    real(bytes);
  };
  crypto.getRandomValues = (<V extends ArrayBufferView | null>(array: V): V => {
    if (array instanceof Uint8Array && array.length === CANARY_BYTES) fill(array, draw);
    else real(array as unknown as Uint8Array);
    return array;
  }) as typeof crypto.getRandomValues;
  try {
    return await body();
  } finally {
    crypto.getRandomValues = real;
  }
}

/** Run `body`, keeping each 16-byte draw it makes. */
export function recordDraws<T>(minted: string[], body: () => Promise<T>): Promise<T> {
  return withCanaryDraws((bytes, real) => {
    real(bytes);
    minted.push(hex(bytes));
  }, body);
}

/** Run `body` drawing `draws` in order; a draw past them is drift. */
export function replayDraws<T>(
  draws: string[],
  drift: ReplayDrift,
  body: () => Promise<T>,
): Promise<T> {
  let next = 0;
  return withCanaryDraws((bytes, real) => {
    const draw = draws[next++];
    if (draw === undefined) {
      drift.stale.push(`draw ${next}: not recorded`);
      real(bytes);
      return;
    }
    bytes.set(fromHex(draw));
  }, body);
}

/** How long a recording waits for the rest of a body the turn stopped reading. */
const DRAIN_MS = 120_000;

/**
 * A fetch that records each call into `exchanges`. The upstream call is not
 * tied to the turn's abort signal, so a body the turn stops reading (a block)
 * is still recorded whole, for a replay that reads further. Await `drained`
 * before saving.
 */
export function recordingFetch(
  exchanges: RecordedExchange[],
  inner: typeof fetch = fetch,
): { fetch: typeof fetch; drained: () => Promise<void> } {
  const pending: Promise<void>[] = [];
  const recording: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    const upstream = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      ...(body ? { body } : {}),
    });
    const response = await inner(upstream);
    const entry: RecordedExchange = {
      method: request.method,
      url: scrubUrl(request.url),
      body,
      status: response.status,
      contentType: response.headers.get('content-type'),
      chunks: [],
    };
    exchanges.push(entry);
    if (!response.body) return response;
    const [mine, theirs] = response.body.tee();
    const reader = mine.pipeThrough(new TextDecoderStream()).getReader();
    const drain = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) entry.chunks.push(value);
      }
    })();
    const deadline = new Promise<'late'>((resolve) => {
      const timer = setTimeout(() => resolve('late'), DRAIN_MS);
      drain.finally(() => clearTimeout(timer)).catch(() => {});
    });
    pending.push(
      Promise.race([drain.then(() => 'done' as const), deadline]).then(
        (end) => {
          if (end === 'late') {
            entry.truncated = true;
            reader.cancel().catch(() => {});
          }
        },
        () => {
          entry.truncated = true;
        },
      ),
    );
    return new Response(theirs, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { fetch: recording, drained: async () => void (await Promise.all(pending)) };
}

/** The first point two texts differ, with a little of each side. */
function firstDifference(recorded: string, now: string): string {
  let at = 0;
  while (at < recorded.length && recorded[at] === now[at]) at++;
  const show = (text: string) => JSON.stringify(text.slice(Math.max(0, at - 40), at + 60));
  return `at ${at}: recorded ${show(recorded)}, now ${show(now)}`;
}

/** A fetch that answers each call from `exchanges` in order; a call that departs from them is drift. */
export function replayFetch(exchanges: RecordedExchange[], drift: ReplayDrift): typeof fetch {
  let next = 0;
  return async (input, init) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    const call = ++next;
    const entry = exchanges[call - 1];
    if (!entry) {
      drift.stale.push(`call ${call}: not recorded`);
      throw new TypeError(`cassette: call ${call} was not recorded`);
    }
    const url = scrubUrl(request.url);
    if (entry.method !== request.method || entry.url !== url) {
      drift.stale.push(
        `call ${call}: ${request.method} ${url}, recorded ${entry.method} ${entry.url}`,
      );
    } else if (entry.body !== body) {
      drift.stale.push(`call ${call}: body differs ${firstDifference(entry.body, body)}`);
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of entry.chunks) controller.enqueue(encoder.encode(chunk));
        if (entry.truncated) controller.error(new TypeError('cassette: body ended early'));
        else controller.close();
      },
    });
    return new Response(stream, {
      status: entry.status,
      headers: entry.contentType ? { 'content-type': entry.contentType } : {},
    });
  };
}

/** Audio is not read by any guardrail; a recording keeps that it was sent, not the samples. */
function withoutAudio(frame: string): string {
  if (!frame.includes('"inlineData"')) return frame;
  try {
    return JSON.stringify(JSON.parse(frame), (key, value) =>
      key === 'inlineData' && typeof value?.data === 'string' ? { ...value, data: 'AAAA' } : value,
    );
  } catch {
    return frame;
  }
}

async function frameText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return await data.text();
  return String(data);
}

/** An `openWebSocket` that records the socket's traffic into `frames`. */
export function recordingSocket(frames: LiveFrame[]): {
  openWebSocket: (url: string) => Promise<WebSocket>;
  drained: () => Promise<void>;
} {
  const pending: Promise<void>[] = [];
  const openWebSocket = (url: string): Promise<WebSocket> => {
    const ws = new WebSocket(url);
    ws.addEventListener('message', (event) => {
      const slot: { received: string } = { received: '' };
      frames.push(slot);
      pending.push(
        frameText(event.data).then((text) => {
          slot.received = withoutAudio(text);
        }),
      );
    });
    ws.addEventListener('close', (event) => {
      frames.push({ closed: { code: event.code, reason: event.reason } });
    });
    const send = ws.send.bind(ws);
    ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
      frames.push({ sent: typeof data === 'string' ? withoutAudio(data) : '[binary]' });
      send(data);
    };
    return Promise.resolve(ws);
  };
  return { openWebSocket, drained: async () => void (await Promise.all(pending)) };
}

/**
 * A socket that plays `frames` back: each recorded server frame is delivered
 * once every client frame recorded before it has been sent, so the client's
 * sends gate the replay as they gated the model.
 */
class ReplaySocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  #frames: LiveFrame[];
  #drift: ReplayDrift;
  #cursor = 0;
  #sends = 0;

  constructor(frames: LiveFrame[], drift: ReplayDrift) {
    super();
    this.#frames = frames.slice();
    this.#drift = drift;
    setTimeout(() => {
      this.readyState = WebSocket.OPEN;
      const event = new Event('open');
      this.onopen?.(event);
      this.dispatchEvent(event);
      this.#deliver();
    }, 0);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const sends = ++this.#sends;
    const text = typeof data === 'string' ? withoutAudio(data) : '[binary]';
    const at = this.#frames.findIndex((frame, i) => i >= this.#cursor && 'sent' in frame);
    if (at === -1) {
      this.#drift.stale.push(`send ${sends}: not recorded`);
      return;
    }
    const recorded = (this.#frames[at] as { sent: string }).sent;
    if (recorded !== text) {
      this.#drift.stale.push(`send ${sends}: differs ${firstDifference(recorded, text)}`);
    }
    this.#frames.splice(at, 1);
    this.#deliver();
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.#closeWith(code, reason);
  }

  #closeWith(code: number, reason: string): void {
    this.readyState = WebSocket.CLOSED;
    const event = new CloseEvent('close', { code, reason });
    this.onclose?.(event);
    this.dispatchEvent(event);
  }

  /** Deliver server frames up to the next client frame still to be sent. */
  #deliver(): void {
    setTimeout(() => {
      if (this.readyState !== WebSocket.OPEN) return;
      const frame = this.#frames[this.#cursor];
      if (!frame || 'sent' in frame) return;
      this.#cursor++;
      if ('closed' in frame) {
        this.#closeWith(frame.closed.code, frame.closed.reason);
        return;
      }
      const event = new MessageEvent('message', { data: frame.received });
      this.onmessage?.(event);
      this.dispatchEvent(event);
      this.#deliver();
    }, 0);
  }
}

/** An `openWebSocket` that replays `frames`. */
export function replaySocket(
  frames: LiveFrame[],
  drift: ReplayDrift,
): (url: string) => Promise<WebSocket> {
  return () => Promise.resolve(new ReplaySocket(frames, drift) as unknown as WebSocket);
}
