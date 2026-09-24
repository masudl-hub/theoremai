/**
 * Shared Gemini Live WebSocket transport helpers.
 *
 * Used by `openGoogleLiveSession` / `runSession`. No ModelProvider.complete() path —
 * live is session-scoped, not turn-scoped.
 *
 * @module
 */

import { type ErrorKind, TheoremError } from '../../../guardrails/error.ts';
import type { ProviderCompleteRequest, TurnEvent } from '../../../kernel/types.ts';
import { readGeminiApiError } from '../api-error.ts';
import {
  buildGeminiLiveClientContent,
  buildGeminiLiveRealtimeInput,
  buildGeminiLiveSetupMessage,
  foldGeminiLiveServerMessage,
  newLiveFold,
  parseGeminiLiveMessage,
  readLiveInteractionStatus,
} from './framing.ts';

const SETUP_TIMEOUT_MS = 20_000;

/** The kind of a provider close, by WebSocket close code (RFC 6455 §7.4.1); any other code is `unavailable`. */
const CLOSE_KINDS: Readonly<Record<number, ErrorKind>> = {
  1006: 'network',
  1007: 'unsupported',
  1008: 'unsupported',
  1011: 'unavailable',
  1013: 'unavailable',
};

/** A normal close once the session is open. */
const NORMAL_CLOSE = 1000;

/** The failure a provider close reports, named by its close code. */
function closeError(code: number, reason: string, during: 'setup' | 'session'): TheoremError {
  return new TheoremError(
    CLOSE_KINDS[code] ?? 'unavailable',
    `Gemini Live WebSocket closed during ${during} (${code}: ${reason})`,
  );
}

export type LiveTurnPhase = 'streaming' | 'complete' | 'abort';

/** Tap row for a frame sent upstream. Received frames travel on the queue instead. */
const LIVE_SEND_ROW = 'ws_send';

/** Send one frame, tapping it first. */
export function sendLiveFrame(
  ws: LiveSocketSender,
  payload: Record<string, unknown>,
  tap: ProviderCompleteRequest['tapUpstream'],
): void {
  tap?.({ eventType: LIVE_SEND_ROW, body: payload });
  ws.send(JSON.stringify(payload));
}

/**
 * One received frame, in arrival order: its normalized events (`batch`), or
 * the frame alone when it folds to nothing (`row`). `row` is the parsed frame,
 * so the kernel records it beside the events it produced.
 */
export type SessionQueueItem =
  | { type: 'batch'; events: TurnEvent[]; turnPhase: LiveTurnPhase; row: Record<string, unknown> }
  | { type: 'row'; row: Record<string, unknown> }
  | { type: 'error'; error: Error; row?: Record<string, unknown> }
  /**
   * The provider closed the socket; `error` names the failure when the close
   * was not normal. `goAway` is set when the provider warned first.
   */
  | { type: 'closed'; code: number; reason: string; error?: TheoremError; goAway?: GoAwayClose };

/** A close the provider warned of (`goAway`): the last warning's window, and when the close came. */
export interface GoAwayClose {
  /** The window the last `goAway` gave; omitted when it gave none. */
  timeLeftMs?: number;
  /** Milliseconds from the last `goAway` to the close. */
  closedAfterMs: number;
}

/** The last `goAway` in a folded frame, if the frame carried one. */
function goAwayIn(events: readonly TurnEvent[]): { timeLeftMs?: number } | undefined {
  const warning = events.findLast((ev) => ev.session?.kind === 'closing_soon');
  return warning ? { timeLeftMs: warning.session?.timeLeftMs } : undefined;
}

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

/** Send setup and resolve with the server's `setupComplete` frame. */
export function performLiveSetup(
  ws: WebSocket,
  req: ProviderCompleteRequest,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let setupResolved = false;
    const timeout = setTimeout(() => {
      if (!setupResolved) {
        setupResolved = true;
        reject(
          new TheoremError('timeout', `Gemini Live setup timed out after ${SETUP_TIMEOUT_MS}ms`),
        );
      }
    }, SETUP_TIMEOUT_MS);

    const sendSetup = () => {
      try {
        sendLiveFrame(ws, buildGeminiLiveSetupMessage(req), req.tapUpstream);
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
        reject(new TheoremError('network', 'Gemini Live WebSocket error during setup'));
      }
    };

    ws.onclose = (evt) => {
      clearTimeout(timeout);
      if (!setupResolved) {
        setupResolved = true;
        reject(closeError(evt.code, evt.reason, 'setup'));
      }
    };

    const initialMessageHandler = async (evt: MessageEvent) => {
      const rawText = await readMessageData(evt.data);
      const parsed = parseGeminiLiveMessage(rawText);
      if (!parsed.ok) {
        if (parsed.reason === 'empty') return;
        clearTimeout(timeout);
        setupResolved = true;
        reject(new TheoremError('bad_response', 'malformed Gemini Live message during setup'));
        return;
      }

      const apiError = readGeminiApiError(parsed.value);
      if (apiError) {
        clearTimeout(timeout);
        setupResolved = true;
        reject(apiError);
        return;
      }

      if (parsed.value.setupComplete) {
        clearTimeout(timeout);
        setupResolved = true;
        ws.removeEventListener('message', initialMessageHandler);
        resolve(parsed.value);
      }
    };

    ws.addEventListener('message', initialMessageHandler);

    // A fetch-upgraded socket (Cloudflare `resp.webSocket.accept()`) is already
    // open and never fires `open`.
    if (ws.readyState === WebSocket.OPEN) {
      sendSetup();
    } else {
      ws.onopen = sendSetup;
    }
  });
}

export type LiveSocketSender = { send(data: string): void };

export function sendInitialPayloads(ws: LiveSocketSender, req: ProviderCompleteRequest): void {
  if (req.history && req.history.length > 0) {
    const historyMsg = buildGeminiLiveClientContent(req.history);
    if (historyMsg) {
      sendLiveFrame(ws, historyMsg, req.tapUpstream);
    }
  }
  for (const part of req.input ?? []) {
    sendLiveFrame(ws, buildGeminiLiveRealtimeInput(part), req.tapUpstream);
  }
}

export interface LiveQueue {
  push: (item: SessionQueueItem) => void;
  next: () => Promise<SessionQueueItem | undefined>;
  close: () => void;
  isClosed: () => boolean;
}

export function createLiveQueue(): LiveQueue {
  const queue: SessionQueueItem[] = [];
  let notify: (() => void) | null = null;
  let closed = false;

  return {
    push(item: SessionQueueItem) {
      queue.push(item);
      if (notify) {
        const fn = notify;
        notify = null;
        fn();
      }
    },
    async next(): Promise<SessionQueueItem | undefined> {
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

/**
 * Conversational cycle boundary.
 *
 * When the server reports `interactionStatus`, that is authoritative: `IDLE`
 * closes the cycle and `IN_PROGRESS` keeps it open even across `turnComplete`
 * (background reasoning / async tools may still produce output). Without the
 * field, `turnComplete` is the boundary as before.
 */
export function turnPhaseFromMessage(
  message: Record<string, unknown>,
  events: TurnEvent[],
): LiveTurnPhase {
  const interrupted = events.some((ev) => ev.type === 'done' && ev.interrupted === true);
  if (interrupted) return 'abort';
  const status = readLiveInteractionStatus(message);
  if (status === 'IDLE') return 'complete';
  if (status === 'IN_PROGRESS') return 'streaming';
  const serverContent = message.serverContent as { turnComplete?: boolean } | undefined;
  if (serverContent?.turnComplete === true) return 'complete';
  return 'streaming';
}

/** Attach handlers that keep the socket open across conversational turns. */
export function attachLiveSessionHandlers(ws: WebSocket, liveQueue: LiveQueue): void {
  const fold = newLiveFold();
  /** The last `goAway`, and when it arrived (monotonic ms). */
  let goAway: { timeLeftMs?: number; atMs: number } | undefined;
  ws.onmessage = async (evt: MessageEvent) => {
    try {
      const rawText = await readMessageData(evt.data);
      const parsed = parseGeminiLiveMessage(rawText);
      if (!parsed.ok) {
        if (parsed.reason === 'empty') return;
        liveQueue.push({
          type: 'error',
          error: new TheoremError('bad_response', 'malformed Gemini Live message'),
        });
        return;
      }
      if (parsed.value.setupComplete) return;

      const apiError = readGeminiApiError(parsed.value);
      if (apiError) {
        liveQueue.push({ type: 'error', error: apiError, row: parsed.value });
        return;
      }

      const events = foldGeminiLiveServerMessage(parsed.value, fold);
      const warning = goAwayIn(events);
      if (warning) goAway = { ...warning, atMs: performance.now() };
      const turnPhase = turnPhaseFromMessage(parsed.value, events);
      liveQueue.push(
        events.length > 0 || turnPhase !== 'streaming'
          ? { type: 'batch', events, turnPhase, row: parsed.value }
          : { type: 'row', row: parsed.value },
      );
    } catch (err) {
      liveQueue.push({
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  };

  ws.onerror = () => {
    if (!liveQueue.isClosed()) {
      liveQueue.push({
        type: 'error',
        error: new TheoremError('network', 'Gemini Live WebSocket error'),
      });
    }
  };

  ws.onclose = (evt) => {
    if (!liveQueue.isClosed()) {
      liveQueue.push({
        type: 'closed',
        code: evt.code,
        reason: evt.reason,
        ...(evt.code === NORMAL_CLOSE
          ? {}
          : { error: closeError(evt.code, evt.reason, 'session') }),
        ...(goAway
          ? {
              goAway: {
                ...(goAway.timeLeftMs !== undefined ? { timeLeftMs: goAway.timeLeftMs } : {}),
                closedAfterMs: Math.round(performance.now() - goAway.atMs),
              },
            }
          : {}),
      });
      liveQueue.close();
    }
  };
}
