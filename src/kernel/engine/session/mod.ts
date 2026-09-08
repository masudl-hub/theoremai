/**
 * `runSession` — long-lived live profile execution.
 *
 * Shares resolve / tools / canary / system / outbound gate with `runTurn`.
 * Does not use `ModelProvider.complete()` — live is a session, not one turn.
 *
 * @module
 */

import { bindCanary } from '../../../guardrails/canary.ts';
import {
  publicError,
  TheorumError,
  throwIfAborted,
  toErrorEvent,
} from '../../../guardrails/error.ts';
import {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  type LiveOutboundGateSession,
  processLiveOutboundBatch,
} from '../../../guardrails/live-outbound-gate.ts';
import { sanitizeTurnRequest } from '../../../guardrails/sanitize.ts';
import type { GeminiTransport } from '../../../providers/google/keys.ts';
import {
  buildGeminiLiveRealtimeInput,
  buildGeminiLiveRealtimeText,
  buildGeminiLiveToolResponse,
  buildGeminiLiveToolResponses,
} from '../../../providers/google/live/framing.ts';
import { openGoogleLiveSession } from '../../../providers/google/live/session.ts';
import { providerCompleteRequest } from '../../registry/provider-request.ts';
import { pickSystemRole, resolveTurn } from '../../registry/resolve.ts';
import type {
  InteractionPart,
  LiveSession,
  Profile,
  ProviderCompleteRequest,
  ResolvedGeneration,
  SessionRequest,
  TurnEvent,
  TurnRequest,
} from '../../types.ts';
import { prepareLiveInboundText } from '../live-inbound.ts';
import { assertLiveIngress } from '../live-ingress.ts';
import { systemFromProfile } from '../runner/stream.ts';

export type { LiveSession, SessionRequest };

export interface RunSessionOptions {
  gemini: GeminiTransport;
  /** Override socket open (Cloudflare fetch-upgrade, tests). Default: `new WebSocket(url)`. */
  openWebSocket?: (url: string) => Promise<WebSocket>;
}

function assertLiveProfile(profile: Profile): void {
  if (profile.type !== 'live') {
    throw new TheorumError(
      `runSession requires profile.type 'live' (got '${profile.type}' for ${profile.id})`,
    );
  }
}

function toTurnRequest(req: SessionRequest): TurnRequest {
  return {
    profile: req.profile,
    system: req.system,
    path: req.path,
    sessionPermissions: req.sessionPermissions,
    sessionResumptionHandle: req.sessionResumptionHandle,
    signal: req.signal,
    metadata: req.metadata,
    input: {
      text: '',
      history: req.history,
      sessionResumptionHandle: req.sessionResumptionHandle,
    },
  };
}

function applyVoiceOverride(
  generation: ResolvedGeneration,
  voice: string | undefined,
): ResolvedGeneration {
  if (!voice || !generation.live) {
    return generation;
  }
  return {
    ...generation,
    live: {
      ...generation.live,
      voice,
    },
  };
}

function applyInitialInput(
  generation: ResolvedGeneration,
  input: InteractionPart[] | undefined,
): ResolvedGeneration {
  if (!input || input.length === 0) {
    return generation;
  }
  return { ...generation, input };
}

async function applyOutbound(
  gate: LiveOutboundGateSession,
  events: TurnEvent[],
  turnPhase: 'streaming' | 'complete' | 'abort',
  onWithhold: (error: string) => void,
): Promise<TurnEvent[]> {
  if (turnPhase === 'abort') {
    abortLiveOutboundTurn(gate);
    // Keep tool calls + interrupted marker; drop buffered speech via abortLiveOutboundTurn.
    return events.filter(
      (ev) =>
        ev.type === 'tool' ||
        ev.type === 'session' ||
        (ev.type === 'done' && ev.interrupted === true),
    );
  }

  const batch = await processLiveOutboundBatch(gate, events);
  const out: TurnEvent[] = [];
  if (batch.action === 'withhold') {
    onWithhold(batch.error);
    return [{ type: 'error', error: batch.error }];
  }
  if (batch.action === 'emit') {
    out.push(...batch.events);
  }

  if (turnPhase === 'complete') {
    const finalized = await finalizeLiveOutboundTurn(gate);
    if (finalized.action === 'withhold') {
      onWithhold(finalized.error);
      return [...out, { type: 'error', error: finalized.error }];
    }
    if (finalized.action === 'emit') {
      out.push(...finalized.events);
    }
    // Conversational turn boundary — session stays open.
    out.push({ type: 'done', stop: { kind: 'completed' } });
  }

  return out;
}

function buildLiveSession(args: {
  profile: Profile;
  canary: string;
  connection: Awaited<ReturnType<typeof openGoogleLiveSession>>;
  gate: LiveOutboundGateSession;
  signal?: AbortSignal;
}): LiveSession {
  const { profile, canary, connection, gate, signal } = args;
  let closed = false;
  let withholdClose: string | undefined;

  const sendJson = (payload: Record<string, unknown>) => {
    if (closed) {
      throw new TheorumError('Live session is closed');
    }
    connection.send(JSON.stringify(payload));
  };

  return {
    profileId: profile.id,
    canary,
    async *events(): AsyncGenerator<TurnEvent> {
      try {
        for await (const item of connection.batches()) {
          throwIfAborted(signal);
          if (item.type === 'closed') {
            break;
          }
          if (item.type === 'error') {
            yield toErrorEvent(item.error);
            break;
          }
          const gated = await applyOutbound(gate, item.events, item.turnPhase, (error) => {
            withholdClose = error;
          });
          for (const ev of gated) {
            if (ev.type === 'error') {
              yield {
                ...ev,
                error: publicError(ev.error ?? withholdClose ?? 'guardrail withheld'),
              };
            } else {
              yield ev;
            }
          }
          if (withholdClose) {
            connection.close(1011, 'guardrail withheld');
            break;
          }
        }
      } finally {
        closed = true;
        connection.close();
      }
    },
    sendAudio(audio: { data: string; mimeType?: string }) {
      assertLiveIngress(profile, 'audio');
      sendJson(
        buildGeminiLiveRealtimeInput({
          type: 'audio',
          mimeType: audio.mimeType ?? 'audio/pcm;rate=16000',
          data: audio.data,
        }),
      );
    },
    sendVideo(video: { data: string; mimeType?: string }) {
      assertLiveIngress(profile, 'video');
      sendJson(
        buildGeminiLiveRealtimeInput({
          type: 'video',
          mimeType: video.mimeType ?? 'image/jpeg',
          data: video.data,
        }),
      );
    },
    sendText(text: string) {
      assertLiveIngress(profile, 'text');
      const safeText = prepareLiveInboundText(profile, text);
      sendJson(buildGeminiLiveRealtimeText(safeText));
    },
    sendToolResponse(id: string, name: string, output: unknown) {
      sendJson(buildGeminiLiveToolResponse(id, name, output));
    },
    sendToolResponses(responses: Array<{ id: string; name: string; output: unknown }>) {
      sendJson(buildGeminiLiveToolResponses(responses));
    },
    close(reason = 'session-closed'): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      connection.close(1000, reason);
      return Promise.resolve();
    },
  };
}

/**
 * Open a gated Gemini Live session for a `type: 'live'` profile.
 *
 * Hosts bridge browser sockets and tool dispatch; THEORUM owns Gemini WS,
 * framing, inbound prep, and outbound canary/egress gates.
 */
export async function runSession(
  req: SessionRequest,
  options: RunSessionOptions,
): Promise<LiveSession> {
  const turnReq = toTurnRequest(req);
  const safe = sanitizeTurnRequest(turnReq);
  throwIfAborted(safe.signal);

  const { profile, generation: gen0 } = resolveTurn(safe);
  assertLiveProfile(profile);

  gen0.builtins = gen0.tools.builtins;

  let generation = applyVoiceOverride(gen0, req.voice);
  generation = applyInitialInput(generation, req.input);

  const role = pickSystemRole(profile, safe.input?.role);
  const combinedSys = [systemFromProfile(profile, role), safe.system].filter(Boolean).join('\n\n');
  const system = bindCanary(combinedSys, generation.canary);
  const completeReq: ProviderCompleteRequest = {
    ...providerCompleteRequest(generation, system),
    ...(req.wireTools ? { wireTools: req.wireTools } : {}),
    signal: safe.signal,
  };

  const gate = createLiveOutboundGateSession(profile, generation.canary || undefined);
  const connection = await openGoogleLiveSession(
    completeReq,
    options.gemini,
    options.openWebSocket,
  );

  return buildLiveSession({
    profile,
    canary: generation.canary,
    connection,
    gate,
    signal: safe.signal,
  });
}
