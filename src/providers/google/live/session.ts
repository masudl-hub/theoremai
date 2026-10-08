import { describeError, isAbortError, TheoremError } from '../../../guardrails/error.ts';
import type { InteractionPart, ProviderCompleteRequest } from '../../../kernel/types.ts';
import { fallbackKey, requireKey } from '../../shared/vault.ts';
import { LIVE_FALLBACK_ROW, type LiveConnection, type LiveQueueItem } from '../../types.ts';
import type { GeminiTransport } from '../keys.ts';
import {
  buildGeminiLiveContext,
  buildGeminiLiveRealtimeInput,
  buildGeminiLiveToolResponse,
  buildGeminiLiveWebSocketUrl,
} from './framing.ts';
import {
  attachLiveSessionHandlers,
  createLiveQueue,
  type LiveQueue,
  performLiveSetup,
  sendInitialPayloads,
  sendLiveFrame,
} from './stream.ts';

/** An open Google Live socket: a {@linkcode LiveConnection}, with `send` for a frame built by hand. */
export interface GoogleLiveConnection extends LiveConnection {
  send(payload: Record<string, unknown>): void;
}

/** Opens the WebSocket for a Live session at a URL. */
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
        // why: closing a socket that already closed throws; the session is over either way.
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

interface OpenedSocket {
  ws: WebSocket;
  liveQueue: LiveQueue;
  detachAbort: () => void;
  setup: Record<string, unknown>;
}

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
      // why: closing a socket that already closed throws; the abort is what the caller sees.
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
      // why: closing a socket that already closed throws; the original error is what the caller sees.
    }
    throw err;
  }
}

/**
 * Open on the pinned key; a quota refusal at setup reopens on the profile's
 * fallback slot when it names one, as `fetchGemini` does for HTTP.
 * The tape records the refusal (`ws_fallback`) before the retry.
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
    const fallback = fallbackKey(req.fallbackKeySlot, transport.vault, primary);
    if (!fallback || !(err instanceof TheoremError) || err.kind !== 'rate_limit') throw err;
    req.tapUpstream?.({
      eventType: LIVE_FALLBACK_ROW,
      from: req.keySlot,
      keySlot: fallback.slot,
      errorKind: err.kind,
      error: describeError(err),
    });
    return await openOnKey(req, fallback.key, openWebSocket);
  }
}

/**
 * Opens a Google Live session for a request: connects, sends the setup and the initial payloads,
 * and returns the connection. A quota refusal at setup reopens on the profile's fallback key.
 *
 * @param openWebSocket Host override, e.g. for a Cloudflare fetch-upgrade.
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

  const send = (payload: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) {
      sendLiveFrame(ws, payload, req.tapUpstream);
    }
  };

  return {
    setup,
    send,
    sendContext(text: string) {
      send(buildGeminiLiveContext(text));
    },
    sendInput(input: InteractionPart) {
      send(buildGeminiLiveRealtimeInput(input));
    },
    sendToolResponse(callId: string, name: string, output: unknown) {
      send(buildGeminiLiveToolResponse(callId, name, output));
    },
    async *batches(): AsyncGenerator<LiveQueueItem> {
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
          // why: closing a socket that already closed throws; the session is over either way.
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
        // why: closing a socket that already closed throws; the session is over either way.
      }
    },
  };
}
