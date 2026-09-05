/**
 * Google Gemini Live WebSocket provider adapter.
 *
 * Connects to Google's bidirectional `BidiGenerateContent` WebSocket service,
 * performs the setup handshake, streams client content/inputs, and yields
 * normalized `TurnEvent` streams.
 *
 * @module
 */

import { isAbortError, TheorumError, toErrorEvent } from '../../../guardrails/error.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../../kernel/types.ts';
import { type GeminiTransport, requireKey } from '../keys.ts';
import {
  buildGeminiLiveClientContent,
  buildGeminiLiveRealtimeInput,
  buildGeminiLiveSetupMessage,
  buildGeminiLiveWebSocketUrl,
  foldGeminiLiveServerMessage,
  parseGeminiLiveMessage,
} from './framing.ts';

const SETUP_TIMEOUT_MS = 20_000;

export async function readMessageData(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return await data.text();
  }
  return String(data);
}

export function readGeminiLiveErrorMessage(message: Record<string, unknown>): string | null {
  const error = message.error;
  if (!error || typeof error !== 'object') return null;
  const record = error as { message?: unknown; status?: unknown; code?: unknown };
  if (typeof record.message === 'string' && record.message.length > 0) {
    const status = typeof record.status === 'string' ? record.status : null;
    return status ? `${status}: ${record.message}` : record.message;
  }
  return 'Gemini returned an error during live session.';
}

export function performLiveSetup(ws: WebSocket, req: ProviderCompleteRequest): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let setupResolved = false;
    const timeout = setTimeout(() => {
      if (!setupResolved) {
        setupResolved = true;
        reject(new TheorumError(`Gemini Live setup timed out after ${SETUP_TIMEOUT_MS}ms`));
      }
    }, SETUP_TIMEOUT_MS);

    ws.onopen = () => {
      try {
        const setupMsg = buildGeminiLiveSetupMessage(req);
        ws.send(JSON.stringify(setupMsg));
      } catch (err) {
        clearTimeout(timeout);
        setupResolved = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      if (!setupResolved) {
        setupResolved = true;
        reject(new TheorumError('Gemini Live WebSocket error during setup'));
      }
    };

    ws.onclose = (evt) => {
      clearTimeout(timeout);
      if (!setupResolved) {
        setupResolved = true;
        reject(
          new TheorumError(
            `Gemini Live WebSocket closed during setup (${evt.code}: ${evt.reason})`,
          ),
        );
      }
    };

    const initialMessageHandler = async (evt: MessageEvent) => {
      const rawText = await readMessageData(evt.data);
      const parsed = parseGeminiLiveMessage(rawText);
      if (!parsed.ok) {
        if (parsed.reason === 'empty') return;
        clearTimeout(timeout);
        setupResolved = true;
        reject(new TheorumError('malformed Gemini Live message during setup'));
        return;
      }

      const errMsg = readGeminiLiveErrorMessage(parsed.value);
      if (errMsg) {
        clearTimeout(timeout);
        setupResolved = true;
        reject(new TheorumError(errMsg));
        return;
      }

      if (parsed.value.setupComplete) {
        clearTimeout(timeout);
        setupResolved = true;
        resolve();
      }
    };

    ws.addEventListener('message', initialMessageHandler);
  });
}

export type LiveSocketSender = { send(data: string): void };

export function sendInitialPayloads(ws: LiveSocketSender, req: ProviderCompleteRequest): void {
  if (req.history && req.history.length > 0) {
    const historyMsg = buildGeminiLiveClientContent(req.history);
    if (historyMsg) {
      ws.send(JSON.stringify(historyMsg));
    }
  }
  if (req.input && req.input.length > 0) {
    for (const part of req.input) {
      const inputMsg = buildGeminiLiveRealtimeInput(part);
      ws.send(JSON.stringify(inputMsg));
    }
  }
}

export type QueueItem =
  | { type: 'event'; events: TurnEvent[] }
  | { type: 'error'; error: Error }
  | { type: 'done' };

export interface LiveQueue {
  push: (item: QueueItem) => void;
  next: () => Promise<QueueItem | undefined>;
  close: () => void;
  isClosed: () => boolean;
}

export function createLiveQueue(): LiveQueue {
  const queue: QueueItem[] = [];
  let notify: (() => void) | null = null;
  let closed = false;

  return {
    push(item: QueueItem) {
      queue.push(item);
      if (notify) {
        const fn = notify;
        notify = null;
        fn();
      }
    },
    async next(): Promise<QueueItem | undefined> {
      while (queue.length === 0) {
        if (closed) return undefined;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      return queue.shift();
    },
    close() {
      closed = true;
      if (notify) {
        const fn = notify;
        notify = null;
        fn();
      }
    },
    isClosed() {
      return closed;
    },
  };
}

function attachLiveStreamHandlers(ws: WebSocket, liveQueue: LiveQueue): void {
  ws.onmessage = async (evt: MessageEvent) => {
    try {
      const rawText = await readMessageData(evt.data);
      const parsed = parseGeminiLiveMessage(rawText);
      if (!parsed.ok) {
        if (parsed.reason === 'empty') return;
        liveQueue.push({
          type: 'error',
          error: new TheorumError('malformed Gemini Live message'),
        });
        return;
      }
      if (parsed.value.setupComplete) return;

      const errMsg = readGeminiLiveErrorMessage(parsed.value);
      if (errMsg) {
        liveQueue.push({ type: 'error', error: new TheorumError(errMsg) });
        return;
      }

      const events = foldGeminiLiveServerMessage(parsed.value);
      if (events.length > 0) {
        liveQueue.push({ type: 'event', events });
      }

      const serverContent = parsed.value.serverContent as { turnComplete?: boolean } | undefined;
      if (serverContent?.turnComplete) {
        liveQueue.push({ type: 'done' });
      }
    } catch (err) {
      liveQueue.push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
    }
  };

  ws.onerror = () => {
    if (!liveQueue.isClosed()) {
      liveQueue.push({ type: 'error', error: new TheorumError('Gemini Live WebSocket error') });
    }
  };

  ws.onclose = () => {
    if (!liveQueue.isClosed()) {
      liveQueue.push({ type: 'done' });
    }
  };
}

/**
 * Connect to Gemini Live API over WebSocket and stream TurnEvents.
 */
export async function* streamGeminiLive(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): AsyncGenerator<TurnEvent> {
  let apiKey: string;
  try {
    const bucket = req.geminiBucket ?? 'freeA';
    apiKey = requireKey(transport.vault, bucket);
  } catch (err) {
    yield toErrorEvent(err);
    return;
  }
  const wsUrl = buildGeminiLiveWebSocketUrl(apiKey);

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    yield toErrorEvent(err);
    return;
  }

  const liveQueue = createLiveQueue();

  const onAbort = () => {
    if (!liveQueue.isClosed()) {
      liveQueue.close();
      try {
        ws.close(1000, 'aborted');
      } catch {
        // Ignore close errors
      }
      liveQueue.push({
        type: 'error',
        error: new DOMException('The operation was aborted.', 'AbortError'),
      });
    }
  };

  if (req.signal) {
    if (req.signal.aborted) {
      onAbort();
      return;
    }
    req.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    await performLiveSetup(ws, req);
  } catch (err) {
    if (req.signal) {
      req.signal.removeEventListener('abort', onAbort);
    }
    try {
      ws.close();
    } catch {
      // Ignore
    }
    yield toErrorEvent(err);
    return;
  }

  attachLiveStreamHandlers(ws, liveQueue);
  sendInitialPayloads(ws, req);

  try {
    while (true) {
      const item = await liveQueue.next();
      if (!item) break;
      if (item.type === 'error') {
        if (isAbortError(item.error)) {
          throw item.error;
        }
        yield toErrorEvent(item.error);
        break;
      }
      if (item.type === 'done') {
        break;
      }
      if (item.type === 'event') {
        for (const ev of item.events) {
          yield ev;
        }
      }
    }
  } finally {
    liveQueue.close();
    if (req.signal) {
      req.signal.removeEventListener('abort', onAbort);
    }
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'turn-finished');
      }
    } catch {
      // Ignore
    }
  }
}

/** Create a `ModelProvider` backed by Google Gemini Live WebSocket streaming. */
export function createGoogleLiveProvider(transport: GeminiTransport): ModelProvider {
  return {
    complete: (req) => streamGeminiLive(req, transport),
  };
}

export { attachLiveStreamHandlers };
