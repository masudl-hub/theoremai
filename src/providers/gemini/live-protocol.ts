import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import {
  defineProtocol,
  type LiveSession,
  type ProtocolContext,
  type ProtocolEvent,
  type ProtocolSocket,
  type TurnRequest,
} from '../../kernel/protocols/mod.ts';
import { type JsonObject, jsonObjectSchema } from '../../kernel/provider-contract.ts';
import type { ProviderCompleteRequest, ProviderEvent } from '../../kernel/types.ts';
import { readGeminiApiError } from '../google/api-error.ts';
import { GOOGLE_BUILTIN_IDS } from '../google/builtins.ts';
import {
  buildGeminiLiveClientContent,
  buildGeminiLiveContext,
  buildGeminiLiveRealtimeInput,
  buildGeminiLiveSetupMessage,
  buildGeminiLiveToolResponse,
  foldGeminiLiveServerMessage,
  newLiveFold,
} from '../google/live/framing.ts';
import { closeError, goAwayIn, turnPhaseFromMessage } from '../google/live/stream.ts';
import { asProtocolEvent } from '../shared/protocol-events.ts';
import type { LiveTurnPhase } from '../types.ts';

const state = z.strictObject({ liveHandle: z.string().min(1) });
type State = z.infer<typeof state>;
type Frames = AsyncIterator<JsonObject>;

const NORMAL_CLOSE = 1000;

/** What a frame that is not the model's says: a close, a socket error, or bytes that are not JSON. */
function socketTrouble(frame: JsonObject, during: 'setup' | 'session'): TheoremError | undefined {
  if (frame.eventType === 'ws_error')
    return new TheoremError('network', `Gemini Live WebSocket error during ${during}`); // labels-exempt: developer diagnostic
  if (frame.eventType === 'ws_unparsed')
    return new TheoremError('bad_response', 'malformed Gemini Live message'); // labels-exempt: developer diagnostic
  return readGeminiApiError(frame) ?? undefined;
}

/** Waits for `setupComplete`; a refusal here comes before any event, so the kernel can try the other key. */
async function setupComplete(frames: Frames, context: ProtocolContext): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new TheoremError(
            'timeout',
            `Gemini Live setup timed out after ${context.limits.connectTimeoutMs}ms`, // labels-exempt: developer diagnostic
          ),
        ),
      context.limits.connectTimeoutMs,
    );
  });
  try {
    for (;;) {
      const next = await Promise.race([frames.next(), late]);
      if (next.done) throw closeError(1006, '', 'setup');
      const frame = next.value;
      if (frame.eventType === 'ws_close')
        throw closeError(Number(frame.code), String(frame.reason ?? ''), 'setup');
      const trouble = socketTrouble(frame, 'setup');
      if (trouble) throw trouble;
      if (frame.setupComplete) return;
    }
  } finally {
    clearTimeout(timer);
  }
}

function wireRequest(context: ProtocolContext, request: TurnRequest<State>) {
  const handle = request.state?.liveHandle;
  const history = request.history ?? [];
  const builtins = request.builtins.filter((builtin) =>
    (GOOGLE_BUILTIN_IDS as readonly string[]).includes(builtin.id),
  );
  const wire = {
    ...request,
    apiId: context.apiId,
    builtins,
    state: undefined,
    tapUpstream: undefined,
    sessionResumptionHandle: handle,
    // why: a resumed session already holds what came before its handle.
    history: handle ? history.slice(request.stateHistoryLength ?? 0) : history,
    live: {
      ...request.live,
      transcription: { ...request.live?.transcription, input: true, output: true },
    },
  } as ProviderCompleteRequest;
  const setup = jsonObjectSchema.parse(
    JSON.parse(JSON.stringify(buildGeminiLiveSetupMessage(wire))),
  );
  return { wire, setup, wroteTools: builtins.map((builtin) => builtin.id) };
}

/** One server message's events, then the stop its turn phase calls for. */
function* batch(
  events: readonly ProviderEvent[],
  phase: LiveTurnPhase,
  handle: string | undefined,
): Generator<ProtocolEvent<State>> {
  // why: usage first, so a turn's tokens are counted before its stop.
  const ordered = [
    ...events.filter((event) => event.type === 'tokens'),
    ...events.filter((event) => event.type !== 'tokens'),
  ];
  for (const event of ordered) {
    const converted = asProtocolEvent<State>(event);
    if (converted) yield converted;
  }
  if (phase === 'abort') return;
  const saved = handle ? { state: { liveHandle: handle } } : {};
  if (events.some((event) => event.type === 'tool' && event.tool.phase === undefined))
    yield { type: 'done', stop: { kind: 'tool' }, ...saved };
  if (phase === 'complete') yield { type: 'done', stop: { kind: 'completed' }, ...saved };
}

function session(
  socket: ProtocolSocket,
  frames: Frames,
  context: ProtocolContext,
  resumedFrom: string | undefined,
): LiveSession<State> {
  const fold = newLiveFold();
  let handle = resumedFrom;
  let goAway: { timeLeftMs?: number; atMs: number } | undefined;
  let closed: ReturnType<NonNullable<LiveSession['closeInfo']>>;
  const send = (frame: Record<string, unknown>) => socket.send(frame as JsonObject);
  return {
    closeInfo: () => closed,
    async *events() {
      for (;;) {
        const next = await frames.next();
        if (next.done) return;
        const frame = next.value;
        if (frame.eventType === 'ws_close') {
          context.signal?.throwIfAborted();
          const code = Number(frame.code);
          const reason = String(frame.reason ?? '');
          closed = {
            code,
            reason,
            ...(code === NORMAL_CLOSE ? {} : { error: closeError(code, reason, 'session') }),
            ...(goAway
              ? {
                  warning: {
                    ...(goAway.timeLeftMs === undefined ? {} : { timeLeftMs: goAway.timeLeftMs }),
                    closedAfterMs: Math.round(performance.now() - goAway.atMs),
                  },
                }
              : {}),
          };
          return;
        }
        const trouble = socketTrouble(frame, 'session');
        if (trouble) throw trouble;
        if (frame.setupComplete) continue;
        const events = foldGeminiLiveServerMessage(frame, fold);
        const warning = goAwayIn(events);
        if (warning) goAway = { ...warning, atMs: performance.now() };
        for (const event of events)
          if (event.type === 'evidence' && event.sessionResumptionHandle)
            handle = event.sessionResumptionHandle;
        yield* batch(events, turnPhaseFromMessage(frame, events), handle);
      }
    },
    sendText: async (text) => send(buildGeminiLiveRealtimeInput({ type: 'text', text })),
    sendAudio: async (media) => send(buildGeminiLiveRealtimeInput({ type: 'audio', ...media })),
    sendVideo: async (media) => send(buildGeminiLiveRealtimeInput({ type: 'video', ...media })),
    sendContext: async (value) =>
      send(
        buildGeminiLiveContext(
          typeof value.server === 'string' ? value.server : JSON.stringify(value),
        ),
      ),
    sendToolResult: async (result) =>
      send(buildGeminiLiveToolResponse(result.callId, result.name, result.text, result.parts)),
    close: async (reason) => socket.close(NORMAL_CLOSE, reason ?? 'session-closed'),
  };
}

/** Gemini Live: a spoken session over one WebSocket. */
export const geminiLive = defineProtocol({
  id: 'geminiLive',
  name: 'Gemini Live',
  description: "Google's Live API for Gemini: a spoken session over one WebSocket.", // labels-exempt: builder field description, read by the studio and docs
  endpoints: { live: '/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent' },
  options: z.strictObject({}),
  continuation: { version: 1, schema: state },
  create(context) {
    return {
      async openSession(request) {
        const { wire, setup, wroteTools } = wireRequest(context, request);
        const socket = await context.connect(setup, { wroteTools });
        const frames = socket.frames()[Symbol.asyncIterator]();
        const abort = () => socket.close(NORMAL_CLOSE, 'aborted');
        context.signal?.addEventListener('abort', abort, { once: true });
        try {
          context.signal?.throwIfAborted();
          await setupComplete(frames, context);
        } catch (error) {
          context.signal?.removeEventListener('abort', abort);
          socket.close(NORMAL_CLOSE, 'setup-failed');
          throw error;
        }
        const history = wire.history?.length
          ? buildGeminiLiveClientContent(wire.history)
          : undefined;
        if (history) socket.send(history as JsonObject);
        for (const part of wire.input)
          socket.send(buildGeminiLiveRealtimeInput(part) as JsonObject);
        return session(socket, frames, context, wire.sessionResumptionHandle);
      },
    };
  },
});
