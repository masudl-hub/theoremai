/**
 * Google Gemini Live session transport — long-lived BidiGenerateContent WebSocket.
 *
 * `turnComplete` is a conversational turn boundary, not session teardown.
 *
 * @module
 */

import { isAbortError, TheoremError } from '../../../guardrails/error.ts';
import type { ProviderCompleteRequest } from '../../../kernel/types.ts';
import { type GeminiTransport, requireKey } from '../keys.ts';
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
  if (!req.keySlot) {
    throw new TheoremError('config', 'Request requires keySlot');
  }
  const apiKey = requireKey(transport.vault, req.keySlot);
  const wsUrl = buildGeminiLiveWebSocketUrl(apiKey);

  let ws: WebSocket;
  try {
    ws = await openWebSocket(wsUrl);
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

  let setup: Record<string, unknown>;
  try {
    setup = await performLiveSetup(ws, req);
  } catch (err) {
    detachAbort();
    try {
      ws.close();
    } catch {
      // Ignore
    }
    throw err;
  }

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
