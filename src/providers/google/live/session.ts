/**
 * Google Gemini Live session transport — long-lived BidiGenerateContent WebSocket.
 *
 * `turnComplete` is a conversational turn boundary, not session teardown.
 *
 * @module
 */

import { describeError, isAbortError, TheoremError } from '../../../guardrails/error.ts';
import type { ProviderCompleteRequest } from '../../../kernel/types.ts';
import { canOverflow, type GeminiTransport, requireKey } from '../keys.ts';
import { buildGeminiLiveWebSocketUrl } from './framing.ts';
import {
  attachLiveSessionHandlers,
  createLiveQueue,
  type LiveQueue,
  performLiveSetup,
  type SessionQueueItem,
  sendInitialPayloads,
  sendLiveFrame,
} from './stream.ts';

export interface GoogleLiveConnection {
  /** The server's `setupComplete` frame. */
  readonly setup: Record<string, unknown>;
  /** Send one frame upstream (tapped as a `ws_send` row). */
  send(payload: Record<string, unknown>): void;
  /** Drain session batches until the socket closes or errors. */
  batches(): AsyncGenerator<SessionQueueItem>;
  close(code?: number, reason?: string): void;
}

export type OpenLiveWebSocket = (url: string) => Promise<WebSocket>;

function defaultOpenWebSocket(url: string): Promise<WebSocket> {
  return Promise.resolve(new WebSocket(url));
}

function attachAbort(ws: WebSocket, liveQueue: LiveQueue, signal?: AbortSignal): () => void {
  const onAbort = () => {
    if (!liveQueue.isClosed()) {
      liveQueue.close();
      try {
        ws.close(1000, 'aborted');
      } catch {
        // Ignore
      }
      liveQueue.push({
        type: 'error',
        error: new DOMException('The operation was aborted.', 'AbortError'),
      });
    }
  };

  if (!signal) {
    return () => {};
  }
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** Tape row: setup on the pinned key was refused for quota, so the session opens on `paid`. */
export const LIVE_OVERFLOW_ROW = 'ws_overflow';

interface OpenedSocket {
  ws: WebSocket;
  liveQueue: LiveQueue;
  detachAbort: () => void;
  setup: Record<string, unknown>;
}

/** Open the socket on one key and complete the setup handshake. */
async function openOnKey(
  req: ProviderCompleteRequest,
  apiKey: string,
  openWebSocket: OpenLiveWebSocket,
): Promise<OpenedSocket> {
  let ws: WebSocket;
  try {
    ws = await openWebSocket(buildGeminiLiveWebSocketUrl(apiKey));
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  const liveQueue = createLiveQueue();
  const detachAbort = attachAbort(ws, liveQueue, req.signal);

  if (req.signal?.aborted) {
    detachAbort();
    try {
      ws.close();
    } catch {
      // Ignore
    }
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  try {
    return { ws, liveQueue, detachAbort, setup: await performLiveSetup(ws, req) };
  } catch (err) {
    detachAbort();
    try {
      ws.close();
    } catch {
      // Ignore
    }
    throw err;
  }
}

/**
 * Open on the pinned key; a quota refusal at setup reopens on the vault's
 * `paid` key when it holds a distinct one, as `fetchGemini` does for HTTP.
 * The tape records the refusal (`ws_overflow`) before the retry.
 */
async function openWithOverflow(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
  openWebSocket: OpenLiveWebSocket,
): Promise<OpenedSocket> {
  if (!req.keySlot) {
    throw new TheoremError('config', 'Request requires keySlot');
  }
  const primary = requireKey(transport.vault, req.keySlot);
  try {
    return await openOnKey(req, primary, openWebSocket);
  } catch (err) {
    const paid = canOverflow(req.keySlot, transport.vault, primary);
    if (!paid || !(err instanceof TheoremError) || err.kind !== 'rate_limit') throw err;
    req.tapUpstream?.({
      eventType: LIVE_OVERFLOW_ROW,
      from: req.keySlot,
      keySlot: 'paid',
      errorKind: err.kind,
      error: describeError(err),
    });
    return await openOnKey(req, paid, openWebSocket);
  }
}

/**
 * Open a long-lived Gemini Live WebSocket after setup handshake.
 * Callers own send / batch drain / close — typically via `runSession`.
 *
 * @param openWebSocket Host override for Cloudflare fetch-upgrade (etc.).
 */
export async function openGoogleLiveSession(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
  openWebSocket: OpenLiveWebSocket = defaultOpenWebSocket,
): Promise<GoogleLiveConnection> {
  const { ws, liveQueue, detachAbort, setup } = await openWithOverflow(
    req,
    transport,
    openWebSocket,
  );

  attachLiveSessionHandlers(ws, liveQueue);
  sendInitialPayloads(ws, req);

  return {
    setup,
    send(payload: Record<string, unknown>) {
      if (ws.readyState === WebSocket.OPEN) {
        sendLiveFrame(ws, payload, req.tapUpstream);
      }
    },
    async *batches(): AsyncGenerator<SessionQueueItem> {
      try {
        while (true) {
          const item = await liveQueue.next();
          if (!item) break;
          if (item.type === 'error' && isAbortError(item.error)) {
            throw item.error;
          }
          yield item;
          if (item.type === 'closed' || item.type === 'error') {
            break;
          }
        }
      } finally {
        detachAbort();
        liveQueue.close();
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, 'session-closed');
          }
        } catch {
          // Ignore
        }
      }
    },
    close(code = 1000, reason = 'session-closed') {
      detachAbort();
      liveQueue.close();
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(code, reason);
        }
      } catch {
        // Ignore
      }
    },
  };
}
