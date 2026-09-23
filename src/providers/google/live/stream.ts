/**
 * Shared Gemini Live WebSocket transport helpers.
 *
 * Used by `openGoogleLiveSession` / `runSession`. No ModelProvider.complete() path —
 * live is session-scoped, not turn-scoped.
 *
 * @module
 */

import { TheoremError } from '../../../guardrails/error.ts';
import type { ProviderCompleteRequest, TurnEvent } from '../../../kernel/types.ts';
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
  | { type: 'closed'; code: number; reason: string };

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
        reject(new TheoremError(`Gemini Live setup timed out after ${SETUP_TIMEOUT_MS}ms`));
      }
    }, SETUP_TIMEOUT_MS);

    ws.onopen = () => {
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
        reject(new TheoremError('Gemini Live WebSocket error during setup'));
      }
    };

    ws.onclose = (evt) => {
      clearTimeout(timeout);
      if (!setupResolved) {
        setupResolved = true;
        reject(
          new TheoremError(
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
        reject(new TheoremError('malformed Gemini Live message during setup'));
        return;
      }

      const errMsg = readGeminiLiveErrorMessage(parsed.value);
      if (errMsg) {
        clearTimeout(timeout);
        setupResolved = true;
        reject(new TheoremError(errMsg));
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
  ws.onmessage = async (evt: MessageEvent) => {
    try {
      const rawText = await readMessageData(evt.data);
      const parsed = parseGeminiLiveMessage(rawText);
      if (!parsed.ok) {
        if (parsed.reason === 'empty') return;
        liveQueue.push({
          type: 'error',
          error: new TheoremError('malformed Gemini Live message'),
        });
        return;
      }
      if (parsed.value.setupComplete) return;

      const errMsg = readGeminiLiveErrorMessage(parsed.value);
      if (errMsg) {
        liveQueue.push({ type: 'error', error: new TheoremError(errMsg), row: parsed.value });
        return;
      }

      const events = foldGeminiLiveServerMessage(parsed.value, fold);
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
      liveQueue.push({ type: 'error', error: new TheoremError('Gemini Live WebSocket error') });
    }
  };

  ws.onclose = (evt) => {
    if (!liveQueue.isClosed()) {
      liveQueue.push({ type: 'closed', code: evt.code, reason: evt.reason });
      liveQueue.close();
    }
  };
}
