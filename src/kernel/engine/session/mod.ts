/**
 * `runSession` — long-lived live profile execution.
 *
 * Shares resolve / tools / canary / system / outbound gate with `runTurn`.
 * Does not use `ModelProvider.complete()` — live is a session, not one turn.
 *
 * Stages: `docs/contracts/stages.md` (cycle map + `executeTool`).
 *
 * @module
 */

import { bindCanary } from '../../../guardrails/canary.ts';
import {
  publicError,
  TheoremError,
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
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
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
import type { TurnStage } from '../../schema.ts';
import { runStage, type StageCallBag, type StageHandler } from '../../stages.ts';
import { profileAllowsInject } from '../../stop.ts';
import {
  executeRegisteredTool,
  formatToolFailureForModel,
  formatToolResult,
} from '../../tools/execute.ts';
import { cloneTurnToolSnapshot } from '../../tools/resolve.ts';
import type {
  ModelToolResult,
  ToolFailure,
  ToolGate,
  TurnToolSnapshot,
} from '../../tools/types.ts';
import type {
  InteractionPart,
  LiveExecuteToolArgs,
  LiveExecuteToolResult,
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

export type { LiveSession, SessionRequest };

export interface RunSessionOptions {
  gemini: GeminiTransport;
  /** Override socket open (Cloudflare fetch-upgrade, tests). Default: `new WebSocket(url)`. */
  openWebSocket?: (url: string) => Promise<WebSocket>;
}

/** Inject on live is realtime text ingress only: no tool role, no media parts. */
function liveInjectTexts(messages: readonly TurnHistoryMessage[]): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') continue;
    if (msg.parts?.length) continue;
    const text = msg.content?.trim();
    if (text) out.push(text);
  }
  return out;
}

function assertLiveProfile(profile: Profile): asserts profile is LiveProfile {
  if (profile.type !== 'live') {
    throw new TheoremError(
      `runSession requires profile.type 'live' (got '${profile.type}' for ${profile.id})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
    // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    const detail = `session snapshot declares tools outside tools.allow: ${[...outside].join(', ')}`;
    throw new TheoremError(`Profile ${profile.id}: ${detail}`);
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

function* drainPendingHostEvents(pendingHostEvents: TurnEvent[]): Generator<TurnEvent> {
  while (pendingHostEvents.length > 0) {
    const pending = pendingHostEvents.shift();
    if (pending) yield pending;
  }
}

function boundaryDoneEvents(
  doneBatch: TurnEvent[],
  turnPhase: string | undefined,
  interrupted: boolean,
): TurnEvent[] {
  if (doneBatch.length > 0) return doneBatch;
  if (turnPhase === 'abort' || interrupted) {
    return [{ type: 'done', stop: { kind: 'interrupted' }, interrupted: true }];
  }
  return [{ type: 'done', stop: { kind: 'completed' } }];
}

/** Yield non-done batch events; return the done subset for boundary handling. */
function* yieldLiveNonDoneEvents(
  gated: TurnEvent[],
  includeMatch: boolean | undefined,
  withholdClose: string | undefined,
  recordAssistantText: (text: string) => void,
): Generator<TurnEvent, TurnEvent[]> {
  const doneBatch = gated.filter((ev) => ev.type === 'done');
  for (const ev of gated) {
    if (ev.type === 'done') continue;
    if (ev.type === 'error') {
      yield {
        ...ev,
        error: publicError(ev.error ?? withholdClose ?? 'guardrail withheld'),
      };
      continue;
    }
    if (ev.type === 'text' && typeof ev.text === 'string') {
      recordAssistantText(ev.text);
    }
    yield projectGuardrailTurnEvent(ev, includeMatch ?? false);
  }
  return doneBatch;
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
  /** Seed for StageContext.history (cloned). */
  historySeed?: TurnHistoryMessage[];
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

  let cycle: 'idle' | 'open' = 'idle';
  let cycleStep = 0;
  const history: TurnHistoryMessage[] = args.historySeed?.length
    ? (structuredClone(args.historySeed) as TurnHistoryMessage[])
    : [];
  /** Serialize stage + ingress so concurrent send* cannot interleave cycles. */
  let ingressChain: Promise<void> = Promise.resolve();

  const recordUserText = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) history.push({ role: 'user', content: trimmed });
  };

  const recordAssistantText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = history.at(-1);
    if (last?.role === 'assistant' && typeof last.content === 'string' && !last.tool_calls) {
      last.content = `${last.content}${trimmed}`;
      return;
    }
    history.push({ role: 'assistant', content: trimmed });
  };

  const recordToolSettle = (tool: {
    name: string;
    callId: string;
    input?: unknown;
    output?: unknown;
    failure?: ToolFailure;
  }) => {
    const args =
      tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
        ? (tool.input as Record<string, unknown>)
        : {};
    const modelResult = tool.failure
      ? formatToolFailureForModel(tool.failure)
      : tool.output !== undefined
        ? {
            finding: typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output),
            data: tool.output,
          }
        : formatToolFailureForModel({
            code: 'error',
            message: 'Tool settled without output', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
          });
    history.push(
      {
        role: 'assistant',
        tool_calls: [
          {
            id: tool.callId,
            type: 'function',
            function: {
              name: tool.name,
              arguments: JSON.stringify(args),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: tool.callId,
        name: tool.name,
        content: formatToolResult(modelResult),
      },
    );
  };

  const enqueuePending = (ev: TurnEvent) => {
    pendingHostEvents.push(projectGuardrailTurnEvent(ev, includeMatch));
  };

  const sendJson = (payload: Record<string, unknown>) => {
    if (closed) {
      throw new TheoremError('Live session is closed'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    connection.send(JSON.stringify(payload));
  };

  const runCycleStage = async (
    stage: TurnStage,
    extra?: StageCallBag,
  ): Promise<{ abort?: boolean | { reason?: string }; injectTexts: string[] }> => {
    const gen = runStage({
      ...extra,
      stage,
      step: Math.max(1, cycleStep),
      history,
      handlers: onStage ? [onStage] : [],
      guardrails: profile.guardrails,
      injectAllowed: profileAllowsInject(profile),
      host: sessionHost,
      signal,
    });
    let result = await gen.next();
    while (!result.done) {
      enqueuePending(result.value);
      result = await gen.next();
    }
    return {
      abort: result.value.abort,
      injectTexts: liveInjectTexts(result.value.inject),
    };
  };

  const ingestPreparedLiveText = (text: string) => {
    const prepared = prepareLiveInboundText(profile, text);
    if (prepared.guardrail) {
      enqueuePending(prepared.guardrail);
    }
    recordUserText(prepared.text);
    sendJson(buildGeminiLiveRealtimeText(prepared.text));
  };

  const applyInjectTexts = (texts: string[]) => {
    for (const text of texts) {
      // Cycle already open — write without re-entering pre_turn.
      assertLiveIngress(profile, 'text');
      ingestPreparedLiveText(text);
    }
  };

  const openCycleIfNeeded = async (): Promise<{ aborted: boolean }> => {
    if (cycle === 'open') return { aborted: false };
    cycle = 'open';
    cycleStep += 1;
    const pre = await runCycleStage('pre_turn');
    if (pre.abort) {
      const done: TurnEvent = {
        type: 'done',
        stop: { kind: 'cancelled' },
        interrupted: true,
      };
      enqueuePending(done);
      await runCycleStage('post_turn', { stop: { kind: 'cancelled' } });
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
    const before = await runCycleStage('before_end', {
      stop: doneEvents.find((e) => e.type === 'done')?.stop,
    });
    if (before.abort) {
      yield { type: 'done', stop: { kind: 'cancelled' }, interrupted: true };
      await runCycleStage('post_turn', { stop: { kind: 'cancelled' } });
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
    await runCycleStage('post_turn', { stop: terminal?.stop });
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
          yield* drainPendingHostEvents(pendingHostEvents);
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

          const doneBatch = yield* yieldLiveNonDoneEvents(
            gated,
            includeMatch,
            withholdClose,
            recordAssistantText,
          );

          const interrupted = doneBatch.some((ev) => ev.type === 'done' && ev.interrupted);
          const completeBoundary =
            item.turnPhase === 'complete' || item.turnPhase === 'abort' || doneBatch.length > 0;

          // Boundary batches (`interactionStatus: IDLE`, or bare `turnComplete` when the
          // provider sends no status) often have no folded `done` — still end the cycle.
          if (completeBoundary && cycle === 'open') {
            const boundaryDone = boundaryDoneEvents(doneBatch, item.turnPhase, interrupted);
            for await (const ev of endCycleAroundDone(boundaryDone)) {
              yield projectGuardrailTurnEvent(ev, includeMatch);
            }
            yield* drainPendingHostEvents(pendingHostEvents);
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
        yield* drainPendingHostEvents(pendingHostEvents);
      } finally {
        closed = true;
        connection.close();
      }
    },
    sendAudio(audio: { data: string; mimeType?: string }): Promise<void> {
      return withIngress(async () => {
        if (!audio.data) return;
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
        ingestPreparedLiveText(text);
      });
    },
    async executeTool(toolArgs: LiveExecuteToolArgs): Promise<LiveExecuteToolResult> {
      if (closed) {
        throw new TheoremError('Live session is closed'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
          profile,
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
        const texts = liveInjectTexts(s.pendingInject);
        if (texts.length) {
          await withIngress(async () => {
            const opened = await openCycleIfNeeded();
            if (!opened.aborted) await applyInjectTexts(texts);
          });
        }
      }

      const outputModel = s.modelResult;
      if (outputModel !== undefined || s.failure) {
        recordToolSettle({
          name: toolArgs.name,
          callId: toolArgs.callId,
          input: toolArgs.input,
          output: s.outputRaw ?? outputModel?.data ?? outputModel,
          failure: s.failure,
        });
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
 * Hosts bridge browser sockets and tool dispatch; THEOREM owns Gemini WS,
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

  const system = bindCanary(
    generation.resolvedSystem,
    generation.canary,
    resolveGuardrailPolicy(profile.guardrails).canaryBindNote,
  );
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
    historySeed: req.history,
    openInitialCycle: hasInitialInput,
  });
}
