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
import { projectGuardrailTurnEvent } from '../../../guardrails/events.ts';
import {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  type LiveOutboundGateSession,
  processLiveOutboundBatch,
} from '../../../guardrails/live-outbound-gate.ts';
import { sanitizeTurnRequest } from '../../../guardrails/sanitize.ts';
import { resolveObservabilityPolicy } from '../../../observability/resolve-policy.ts';
import type { GeminiTransport } from '../../../providers/google/keys.ts';
import {
  buildGeminiLiveRealtimeInput,
  buildGeminiLiveRealtimeText,
  buildGeminiLiveToolResponse,
  buildGeminiLiveToolResponses,
} from '../../../providers/google/live/framing.ts';
import { openGoogleLiveSession } from '../../../providers/google/live/session.ts';
import { providerCompleteRequest } from '../../registry/provider-request.ts';
import { resolveTurn } from '../../registry/resolve.ts';
import { cloneTurnToolSnapshot } from '../../tools/resolve.ts';
import type { TurnToolSnapshot } from '../../tools/types.ts';
import type {
  InteractionPart,
  LiveProfile,
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

export type { LiveSession, SessionRequest };

export interface RunSessionOptions {
  gemini: GeminiTransport;
  /** Override socket open (Cloudflare fetch-upgrade, tests). Default: `new WebSocket(url)`. */
  openWebSocket?: (url: string) => Promise<WebSocket>;
}

function assertLiveProfile(profile: Profile): asserts profile is LiveProfile {
  if (profile.type !== 'live') {
    throw new TheorumError(
      `runSession requires profile.type 'live' (got '${profile.type}' for ${profile.id})`,
    );
  }
}

/**
 * Accept a registry-resolved snapshot from the process that owns the tool
 * registry. The profile's `tools.allow` stays the ceiling: a custom tool id
 * outside it is refused rather than declared.
 */
function sessionSnapshotWithinAllow(
  profile: LiveProfile,
  snapshot: TurnToolSnapshot,
): TurnToolSnapshot {
  const allow = new Set<string>(profile.tools.allow);
  const builtins = new Set<string>(snapshot.builtins);
  const outside = new Set<string>();
  for (const id of [...snapshot.gated, ...snapshot.visible, ...snapshot.executable]) {
    if (!allow.has(id) && !builtins.has(id)) {
      outside.add(id);
    }
  }
  if (outside.size > 0) {
    throw new TheorumError(
      `Profile ${profile.id}: session snapshot declares tools outside tools.allow: ${[...outside].join(', ')}`,
    );
  }
  return cloneTurnToolSnapshot(snapshot);
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
    return [...(batch.events ?? []), { type: 'error', error: batch.error }];
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
  const pendingHostEvents: TurnEvent[] = [];
  const includeMatch = resolveObservabilityPolicy(profile.observability).include
    .guardrailMatchPreview;

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
          while (pendingHostEvents.length > 0) {
            const pending = pendingHostEvents.shift();
            if (pending) {
              yield projectGuardrailTurnEvent(pending, includeMatch);
            }
          }
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
              yield projectGuardrailTurnEvent(ev, includeMatch);
            }
          }
          if (withholdClose) {
            connection.close(1011, 'guardrail withheld');
            break;
          }
        }
        while (pendingHostEvents.length > 0) {
          const pending = pendingHostEvents.shift();
          if (pending) {
            yield projectGuardrailTurnEvent(pending, includeMatch);
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
      const prepared = prepareLiveInboundText(profile, text);
      if (prepared.guardrail) {
        pendingHostEvents.push(prepared.guardrail);
      }
      sendJson(buildGeminiLiveRealtimeText(prepared.text));
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

  if (req.snapshot) {
    gen0.tools = sessionSnapshotWithinAllow(profile, req.snapshot);
  }
  gen0.builtins = gen0.tools.builtins;

  let generation = applyVoiceOverride(gen0, req.voice);
  generation = applyInitialInput(generation, req.input);

  const system = bindCanary(generation.resolvedSystem, generation.canary);
  const completeReq: ProviderCompleteRequest = {
    ...providerCompleteRequest(generation, system),
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
