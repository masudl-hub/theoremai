/**
 * `runSession` — long-lived live profile execution.
 *
 * Shares resolve / tools / canary / system / outbound gate with `runTurn`.
 * Does not use `ModelProvider.complete()` — live is a session, not one turn.
 *
 * Stages: `docs/contracts/stages.md` (slice 3 cycle map + `executeTool`).
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
import type { ToolCredential } from '../../auth/types.ts';
import { providerCompleteRequest } from '../../registry/provider-request.ts';
import { resolveTurn } from '../../registry/resolve.ts';
import type { StageHandler } from '../../stages.ts';
import { profileAllowsInject } from '../../stop.ts';
import { executeRegisteredTool } from '../../tools/execute.ts';
import { cloneTurnToolSnapshot } from '../../tools/resolve.ts';
import type {
  InvokeToolResume,
  ModelToolResult,
  ToolFailure,
  ToolGate,
  TurnToolSnapshot,
} from '../../tools/types.ts';
import type {
  InteractionPart,
  LiveProfile,
  LiveSession,
  Profile,
  ProviderCompleteRequest,
  ResolvedGeneration,
  SessionRequest,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
} from '../../types.ts';
import { prepareLiveInboundText } from '../live-inbound.ts';
import { assertLiveIngress } from '../live-ingress.ts';
import { applyLiveStage, isEmptyLiveAudio, type LiveCycleState } from './stages.ts';

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
    host: req.host,
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
  profile: LiveProfile;
  canary: string;
  connection: Awaited<ReturnType<typeof openGoogleLiveSession>>;
  gate: LiveOutboundGateSession;
  signal?: AbortSignal;
  onStage?: StageHandler;
  host?: unknown;
  credentials?: Record<string, ToolCredential>;
  sessionPermissions?: string[];
  path?: string;
  snapshot: TurnToolSnapshot;
  /** Open cycle for initial setup input when present. */
  openInitialCycle: boolean;
}): LiveSession {
  const {
    profile,
    canary,
    connection,
    gate,
    signal,
    onStage,
    host: sessionHost,
    credentials: sessionCredentials,
    sessionPermissions,
    path,
    snapshot,
  } = args;

  let closed = false;
  let withholdClose: string | undefined;
  const pendingHostEvents: TurnEvent[] = [];
  const includeMatch = resolveObservabilityPolicy(profile.observability).include
    .guardrailMatchPreview;

  let cycle: LiveCycleState = 'idle';
  let cycleStep = 0;
  const history: TurnHistoryMessage[] = [];
  /** Serialize stage + ingress so concurrent send* cannot interleave cycles. */
  let ingressChain: Promise<void> = Promise.resolve();

  const enqueuePending = (ev: TurnEvent) => {
    pendingHostEvents.push(projectGuardrailTurnEvent(ev, includeMatch));
  };

  const sendJson = (payload: Record<string, unknown>) => {
    if (closed) {
      throw new TheorumError('Live session is closed');
    }
    connection.send(JSON.stringify(payload));
  };

  const runStage = async (
    stage: Parameters<typeof applyLiveStage>[0]['stage'],
    extra?: Partial<Parameters<typeof applyLiveStage>[0]>,
  ): Promise<{ abort?: boolean | { reason?: string }; injectTexts: string[] }> => {
    const gen = applyLiveStage({
      profile,
      stage,
      step: Math.max(1, cycleStep),
      history,
      onStage,
      signal,
      host: sessionHost,
      ...extra,
    });
    let result = await gen.next();
    while (!result.done) {
      enqueuePending(result.value);
      result = await gen.next();
    }
    return result.value;
  };

  const applyInjectTexts = async (texts: string[]) => {
    for (const text of texts) {
      // Cycle already open — write without re-entering pre_turn.
      assertLiveIngress(profile, 'text');
      const prepared = prepareLiveInboundText(profile, text);
      if (prepared.guardrail) {
        enqueuePending(prepared.guardrail);
      }
      sendJson(buildGeminiLiveRealtimeText(prepared.text));
    }
  };

  const openCycleIfNeeded = async (): Promise<{ aborted: boolean }> => {
    if (cycle === 'open') return { aborted: false };
    cycle = 'open';
    cycleStep += 1;
    const pre = await runStage('pre_turn');
    if (pre.abort) {
      const done: TurnEvent = {
        type: 'done',
        stop: { kind: 'cancelled' },
        interrupted: true,
      };
      enqueuePending(done);
      await runStage('post_turn', { stop: { kind: 'cancelled' } });
      cycle = 'idle';
      return { aborted: true };
    }
    if (pre.injectTexts.length) {
      await applyInjectTexts(pre.injectTexts);
    }
    return { aborted: false };
  };

  const endCycleAroundDone = async function* (doneEvents: TurnEvent[]): AsyncGenerator<TurnEvent> {
    if (cycle !== 'open') {
      for (const ev of doneEvents) yield ev;
      return;
    }
    const before = await runStage('before_end', {
      stop: doneEvents.find((e) => e.type === 'done')?.stop,
    });
    if (before.abort) {
      yield { type: 'done', stop: { kind: 'cancelled' }, interrupted: true };
      const post = await runStage('post_turn', { stop: { kind: 'cancelled' } });
      if (post.injectTexts.length) {
        // post_turn never injects — applyStageResult drops it; nothing to do.
      }
      cycle = 'idle';
      return;
    }
    if (before.injectTexts.length) {
      await applyInjectTexts(before.injectTexts);
    }
    for (const ev of doneEvents) {
      yield ev;
    }
    const terminal = doneEvents.find((e) => e.type === 'done');
    await runStage('post_turn', { stop: terminal?.stop });
    cycle = 'idle';
  };

  const withIngress = (fn: () => Promise<void>): Promise<void> => {
    const next = ingressChain.then(fn, fn);
    ingressChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const session: LiveSession = {
    profileId: profile.id,
    canary,
    async *events(): AsyncGenerator<TurnEvent> {
      try {
        for await (const item of connection.batches()) {
          throwIfAborted(signal);
          while (pendingHostEvents.length > 0) {
            const pending = pendingHostEvents.shift();
            if (pending) yield pending;
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

          const doneBatch = gated.filter((ev) => ev.type === 'done');
          const other = gated.filter((ev) => ev.type !== 'done');
          for (const ev of other) {
            if (ev.type === 'error') {
              yield {
                ...ev,
                error: publicError(ev.error ?? withholdClose ?? 'guardrail withheld'),
              };
            } else {
              yield projectGuardrailTurnEvent(ev, includeMatch);
            }
          }

          const interrupted = doneBatch.some((ev) => ev.type === 'done' && ev.interrupted);
          const completeBoundary =
            item.turnPhase === 'complete' || item.turnPhase === 'abort' || doneBatch.length > 0;

          if (completeBoundary && (doneBatch.length > 0 || interrupted)) {
            const boundaryDone =
              doneBatch.length > 0
                ? doneBatch
                : [
                    {
                      type: 'done' as const,
                      stop: { kind: 'interrupted' as const },
                      interrupted: true,
                    },
                  ];
            for await (const ev of endCycleAroundDone(boundaryDone)) {
              yield projectGuardrailTurnEvent(ev, includeMatch);
            }
          } else if (doneBatch.length > 0) {
            for (const ev of doneBatch) {
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
          if (pending) yield pending;
        }
      } finally {
        closed = true;
        connection.close();
      }
    },
    sendAudio(audio: { data: string; mimeType?: string }): Promise<void> {
      return withIngress(async () => {
        if (isEmptyLiveAudio(audio.data)) return;
        assertLiveIngress(profile, 'audio');
        const opened = await openCycleIfNeeded();
        if (opened.aborted) return;
        sendJson(
          buildGeminiLiveRealtimeInput({
            type: 'audio',
            mimeType: audio.mimeType ?? 'audio/pcm;rate=16000',
            data: audio.data,
          }),
        );
      });
    },
    sendVideo(video: { data: string; mimeType?: string }): Promise<void> {
      return withIngress(async () => {
        assertLiveIngress(profile, 'video');
        const opened = await openCycleIfNeeded();
        if (opened.aborted) return;
        sendJson(
          buildGeminiLiveRealtimeInput({
            type: 'video',
            mimeType: video.mimeType ?? 'image/jpeg',
            data: video.data,
          }),
        );
      });
    },
    sendText(text: string): Promise<void> {
      return withIngress(async () => {
        assertLiveIngress(profile, 'text');
        const opened = await openCycleIfNeeded();
        if (opened.aborted) return;
        const prepared = prepareLiveInboundText(profile, text);
        if (prepared.guardrail) {
          enqueuePending(prepared.guardrail);
        }
        sendJson(buildGeminiLiveRealtimeText(prepared.text));
      });
    },
    async executeTool(toolArgs: {
      name: string;
      callId: string;
      input?: unknown;
      resume?: InvokeToolResume;
      credentials?: Record<string, ToolCredential>;
      host?: unknown;
    }): Promise<{
      outputRaw?: unknown;
      outputModel?: ModelToolResult;
      failure?: ToolFailure;
      awaiting?: boolean;
      gated?: ToolGate;
    }> {
      if (closed) {
        throw new TheorumError('Live session is closed');
      }
      const handlers = onStage ? [onStage] : [];
      const exec = executeRegisteredTool({
        profile,
        name: toolArgs.name,
        input: toolArgs.input ?? {},
        callId: toolArgs.callId,
        ctx: {
          sessionPermissions,
          credentials: toolArgs.credentials ?? sessionCredentials,
          path,
          signal,
          resume: toolArgs.resume,
          host: toolArgs.host ?? sessionHost,
          turn: { step: Math.max(1, cycleStep) },
        },
        snapshot,
        stages: {
          handlers,
          step: Math.max(1, cycleStep),
          history: () => history,
          injectAllowed: profileAllowsInject(profile),
          host: toolArgs.host ?? sessionHost,
          signal,
        },
      });

      let settlement: Awaited<ReturnType<typeof exec.next>>['value'];
      while (true) {
        const next = await exec.next();
        if (next.done) {
          settlement = next.value;
          break;
        }
        enqueuePending(next.value);
      }

      if (!settlement || typeof settlement !== 'object') {
        return {};
      }

      const s = settlement as {
        modelResult?: ModelToolResult;
        gated?: ToolGate;
        failure?: ToolFailure;
        awaiting?: boolean;
        outputRaw?: unknown;
        callNotStarted?: boolean;
        pendingInject?: TurnHistoryMessage[];
      };

      if (s.gated) {
        return { gated: s.gated };
      }

      // post_tool inject on live → schedule text ingress
      if (s.pendingInject?.length) {
        const texts = s.pendingInject
          .filter((m) => m.role !== 'tool' && !m.parts?.length)
          .map((m) => m.content?.trim())
          .filter((t): t is string => Boolean(t));
        if (texts.length) {
          await withIngress(async () => {
            const opened = await openCycleIfNeeded();
            if (!opened.aborted) await applyInjectTexts(texts);
          });
        }
      }

      const outputModel = s.modelResult;
      if (outputModel !== undefined || s.failure) {
        const upstream =
          outputModel ??
          ({
            finding: s.failure ? `Tool error (${s.failure.code}): ${s.failure.message}` : 'error',
            data: s.failure,
          } satisfies ModelToolResult);
        sendJson(
          buildGeminiLiveToolResponse(toolArgs.callId, toolArgs.name, upstream.data ?? upstream),
        );
      }

      return {
        outputRaw: s.outputRaw,
        outputModel,
        failure: s.failure,
        awaiting: s.awaiting,
      };
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

  if (args.openInitialCycle) {
    void withIngress(async () => {
      await openCycleIfNeeded();
    });
  }

  return session;
}

/**
 * Open a gated Gemini Live session for a `type: 'live'` profile.
 *
 * Hosts bridge browser sockets and tool dispatch; THEORUM owns Gemini WS,
 * framing, inbound prep, outbound canary/egress gates, and live stages.
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
  const hasInitialInput = Boolean(req.input && req.input.length > 0);
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
    onStage: req.onStage,
    host: req.host,
    credentials: req.credentials,
    sessionPermissions: req.sessionPermissions,
    path: req.path,
    snapshot: gen0.tools,
    openInitialCycle: hasInitialInput,
  });
}
