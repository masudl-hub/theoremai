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
  describeError,
  errorKind,
  TheoremError,
  throwIfAborted,
  toErrorEvent,
  withPublicWording,
} from '../../../guardrails/error.ts';
import { projectGuardrailTurnEvent } from '../../../guardrails/events.ts';
import {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  type LiveOutboundGateSession,
  processLiveOutboundBatch,
} from '../../../guardrails/live-outbound-gate.ts';
import type { ResolveHost } from '../../../guardrails/network.ts';
import { sanitizeTurnRequest } from '../../../guardrails/sanitize.ts';
import { resolveObservabilityPolicy } from '../../../observability/resolve-policy.ts';
import type { TraceSink } from '../../../observability/trace-sink.ts';
import type { GeminiTransport } from '../../../providers/google/keys.ts';
import {
  buildGeminiLiveRealtimeInput,
  buildGeminiLiveToolResponse,
  buildGeminiLiveToolResponses,
  liveFunctionResponsePayload,
} from '../../../providers/google/live/framing.ts';
import { openGoogleLiveSession } from '../../../providers/google/live/session.ts';
import type { GoAwayClose, SessionQueueItem } from '../../../providers/google/live/stream.ts';
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
  type ToolExecuteSettlement,
} from '../../tools/execute.ts';
import { modelResultFromOutput } from '../../tools/remote.ts';
import { cloneTurnToolSnapshot } from '../../tools/resolve.ts';
import type { ToolFailure, TurnToolSnapshot } from '../../tools/types.ts';
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
import { mediaTokenFamily } from '../token-estimate.ts';
import { type LiveCloser, type LiveTrace, startLiveTrace } from './session-trace.ts';

export type { LiveSession, SessionRequest };

/**
 * Host-provided transport dependencies for `runSession` on a Gemini Live profile.
 * `openWebSocket` exists for non-browser runtimes and deterministic tests.
 */
export interface RunSessionOptions {
  gemini: GeminiTransport;
  /** Override socket open (Cloudflare fetch-upgrade, tests). Default: `new WebSocket(url)`. */
  openWebSocket?: (url: string) => Promise<WebSocket>;
}

/**
 * The provider's close after it warned of it (`goAway`): the session's last
 * event, not a failure. Every close fact rides along for the builder; the raw
 * close text is `errorInternal`, which `forClient` strips.
 */
function sessionEndedEvent(
  closed: Extract<SessionQueueItem, { type: 'closed' }>,
  goAway: GoAwayClose,
): TurnEvent {
  const internal = closed.error ? describeError(closed.error) : closed.reason;
  return {
    type: 'session',
    session: {
      kind: 'ended',
      ...(goAway.timeLeftMs !== undefined ? { timeLeftMs: goAway.timeLeftMs } : {}),
      ended: {
        cause: 'go_away',
        code: closed.code,
        closedAfterMs: goAway.closedAfterMs,
        ...(closed.error ? { errorKind: errorKind(closed.error) } : {}),
      },
    },
    ...(internal ? { errorInternal: internal } : {}),
  };
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
      'request',
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
    throw new TheoremError('config', `Profile ${profile.id}: ${detail}`);
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
  onWithhold: () => void,
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
    onWithhold();
    return [...(batch.events ?? []), toErrorEvent(batch.error)];
  }
  if (batch.action === 'emit') {
    out.push(...batch.events);
  }

  if (turnPhase === 'complete') {
    const finalized = await finalizeLiveOutboundTurn(gate);
    if (finalized.action === 'withhold') {
      onWithhold();
      return [...out, toErrorEvent(finalized.error)];
    }
    if (finalized.action === 'emit') {
      out.push(...finalized.events);
    }
    // Conversational turn boundary — session stays open.
    out.push({ type: 'done', stop: { kind: 'completed' } });
  }

  return out;
}

/**
 * The output a settled Live call sends upstream, or `undefined` when nothing
 * is sent (a gate, or no result). The model reads it as the `functionResponse`:
 * the same guarded text a turn sends, never the tool's raw output.
 */
function liveToolOutput(s: ToolExecuteSettlement): string | undefined {
  if (s.gated) return undefined;
  const result = s.modelResult ?? (s.failure ? formatToolFailureForModel(s.failure) : undefined);
  return result ? formatToolResult(result) : undefined;
}

/** What the model reads back from a Live call: the `functionResponse.response` sent. */
function liveReadBack(s: ToolExecuteSettlement): { text: string } | undefined {
  const output = liveToolOutput(s);
  return output === undefined
    ? undefined
    : { text: JSON.stringify(liveFunctionResponsePayload(output)) };
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
  recordAssistantText: (text: string) => void,
): Generator<TurnEvent, TurnEvent[]> {
  const doneBatch = gated.filter((ev) => ev.type === 'done');
  for (const ev of gated) {
    if (ev.type === 'done') continue;
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
  resolveHost?: ResolveHost;
  sessionPermissions?: string[];
  path?: string;
  snapshot: TurnToolSnapshot;
  /** Seed for StageContext.history (cloned). */
  historySeed?: TurnHistoryMessage[];
  /** Open cycle for initial setup input when present. */
  openInitialCycle: boolean;
  trace: LiveTrace;
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
    resolveHost,
    sessionPermissions,
    path,
    snapshot,
    trace,
  } = args;

  let closed = false;
  let withholdClose = false;
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
        ? modelResultFromOutput(tool.output)
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
      throw new TheoremError('request', 'Live session is closed'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    connection.send(payload);
  };

  const closeSocket = (code: number, reason: string, initiator: LiveCloser) => {
    trace.socketClosed(code, reason, initiator);
    connection.close(code, reason);
  };

  /** A `done` names the response span it ends. */
  const stampDone = (ev: TurnEvent): TurnEvent => {
    const traceparent = ev.type === 'done' ? trace.responseTraceparent() : undefined;
    return traceparent ? { ...ev, traceparent } : ev;
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
      span: trace.root,
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
      trace.inbound(prepared.guardrail);
      enqueuePending(prepared.guardrail);
    }
    recordUserText(prepared.text);
    sendJson(buildGeminiLiveRealtimeInput({ type: 'text', text: prepared.text }));
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

  /** The session's events, as the host receives them. */
  const streamToHost = async function* (): AsyncGenerator<TurnEvent> {
    // Who closes the socket when the loop ends: the host, unless THEOREM stops it.
    let closer: LiveCloser = 'host';
    let thrown: unknown;
    try {
      for await (const item of connection.batches()) {
        throwIfAborted(signal);
        trace.receive(item);
        yield* drainPendingHostEvents(pendingHostEvents);
        if (item.type === 'closed') {
          if (item.goAway) yield sessionEndedEvent(item, item.goAway);
          else if (item.error) yield toErrorEvent(item.error);
          break;
        }
        if (item.type === 'error') {
          closer = 'theorem';
          yield toErrorEvent(item.error);
          break;
        }
        if (item.type === 'row') {
          continue;
        }
        // Usage is held per response and emitted once, reported or estimated, by `settle`.
        const gated = await applyOutbound(
          gate,
          item.events.filter((ev) => ev.type !== 'tokens'),
          item.turnPhase,
          () => {
            withholdClose = true;
          },
        );
        for (const ev of gated) {
          if (ev.guardrail) trace.outbound(ev);
        }

        const doneBatch = yield* yieldLiveNonDoneEvents(gated, includeMatch, recordAssistantText);
        const tokens = await trace.settle();
        if (tokens) yield tokens;

        const interrupted = doneBatch.some((ev) => ev.type === 'done' && ev.interrupted);
        const completeBoundary =
          item.turnPhase === 'complete' || item.turnPhase === 'abort' || doneBatch.length > 0;

        // Boundary batches (`interactionStatus: IDLE`, or bare `turnComplete` when the
        // provider sends no status) often have no folded `done` — still end the cycle.
        if (completeBoundary && cycle === 'open') {
          const boundaryDone = boundaryDoneEvents(doneBatch, item.turnPhase, interrupted);
          for await (const ev of endCycleAroundDone(boundaryDone)) {
            yield projectGuardrailTurnEvent(stampDone(ev), includeMatch);
          }
          yield* drainPendingHostEvents(pendingHostEvents);
        } else if (doneBatch.length > 0) {
          for (const ev of doneBatch) {
            yield projectGuardrailTurnEvent(stampDone(ev), includeMatch);
          }
        }

        if (withholdClose) {
          closer = 'theorem';
          break;
        }
      }
      yield* drainPendingHostEvents(pendingHostEvents);
    } catch (err) {
      thrown = err;
      throw err;
    } finally {
      closed = true;
      if (withholdClose) closeSocket(1011, 'guardrail withheld', closer);
      else closeSocket(1000, 'session-closed', closer);
      await trace.close({ thrown });
    }
  };

  const session: LiveSession = {
    profileId: profile.id,
    canary,
    async *events(): AsyncGenerator<TurnEvent> {
      for await (const raw of streamToHost()) {
        const event = withPublicWording(raw, profile.lexicon);
        trace.delivered(event);
        yield event;
      }
    },
    sendAudio(audio: { data: string; mimeType: string }): Promise<void> {
      return withIngress(async () => {
        if (!audio.data) return;
        assertLiveIngress(profile, 'audio');
        const opened = await openCycleIfNeeded();
        if (opened.aborted) return;
        sendJson(
          buildGeminiLiveRealtimeInput({
            type: 'audio',
            mimeType: audio.mimeType,
            data: audio.data,
          }),
        );
      });
    },
    sendVideo(video: { data: string; mimeType: string }): Promise<void> {
      return withIngress(async () => {
        assertLiveIngress(profile, 'video');
        const opened = await openCycleIfNeeded();
        if (opened.aborted) return;
        sendJson(
          buildGeminiLiveRealtimeInput({
            type: 'video',
            mimeType: video.mimeType,
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
        throw new TheoremError('request', 'Live session is closed'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      }
      const handlers = onStage ? [onStage] : [];
      const record = trace.toolRecord(toolArgs.callId);
      const exec = executeRegisteredTool({
        profile,
        name: toolArgs.name,
        input: toolArgs.input ?? {},
        callId: toolArgs.callId,
        ctx: {
          sessionPermissions,
          credentials: toolArgs.credentials ?? sessionCredentials,
          resolveHost,
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
        openSpan: record.open,
        readBack: liveReadBack,
      });

      let s: ToolExecuteSettlement;
      try {
        while (true) {
          const next = await exec.next();
          if (next.done) {
            s = next.value;
            break;
          }
          enqueuePending(next.value);
        }
      } finally {
        record.finish();
      }

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
      const output = liveToolOutput(s);
      if (output !== undefined) {
        recordToolSettle({
          name: toolArgs.name,
          callId: toolArgs.callId,
          input: toolArgs.input,
          output: s.outputRaw ?? outputModel?.data ?? outputModel,
          failure: s.failure,
        });
        sendJson(buildGeminiLiveToolResponse(toolArgs.callId, toolArgs.name, output));
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
      if (!closed) {
        closed = true;
        closeSocket(1000, reason, 'host');
      }
      // The session record is sealed here; frames the host reads after closing are not in it.
      return trace.close({});
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
 * Open a gated Gemini Live session for a `type: 'live'` profile, and trace it
 * (`session-trace.ts`): the session record is written however the session
 * ends, including when opening it fails.
 *
 * Hosts bridge browser sockets and tool dispatch; THEOREM owns Gemini WS,
 * framing, inbound prep, outbound canary/egress gates, and live stages.
 */
export async function runSession(
  req: SessionRequest,
  options: RunSessionOptions,
  sinkOverride?: TraceSink,
): Promise<LiveSession> {
  const trace = startLiveTrace(req, sinkOverride);
  try {
    return await openTracedSession(req, options, trace);
  } catch (err) {
    await trace.close({ thrown: err });
    throw err;
  }
}

async function openTracedSession(
  req: SessionRequest,
  options: RunSessionOptions,
  trace: LiveTrace,
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

  const system = bindCanary(generation.resolvedSystem, generation.canary, profile.lexicon);
  const completeReq: ProviderCompleteRequest = {
    ...providerCompleteRequest(generation, system),
    signal: safe.signal,
    tapUpstream: trace.sent,
  };
  const binding = profile.models[generation.model];
  trace.bind({
    request: completeReq,
    generation,
    binding,
    family: binding ? mediaTokenFamily(binding) : undefined,
    system,
    canary: generation.canary,
  });

  const gate = createLiveOutboundGateSession(profile, generation.canary || undefined, system);
  const connection = await openGoogleLiveSession(
    completeReq,
    options.gemini,
    options.openWebSocket,
  );
  trace.setup(connection.setup);

  return buildLiveSession({
    profile,
    canary: generation.canary,
    connection,
    gate,
    signal: safe.signal,
    onStage: req.onStage,
    host: req.host,
    credentials: req.credentials,
    resolveHost: req.resolveHost,
    sessionPermissions: req.sessionPermissions,
    path: req.path,
    snapshot: gen0.tools,
    historySeed: req.history,
    openInitialCycle: hasInitialInput,
    trace,
  });
}
