import { bindCanary, bindUserDataNote } from '../../../guardrails/canary.ts';
import {
  describeError,
  errorKind,
  TheoremError,
  throwIfAborted,
  toErrorEvent,
  withPublicWording,
} from '../../../guardrails/error.ts';
import { projectGuardrailTurnEvent } from '../../../guardrails/events.ts';
import { type LexiconOverrides, lexiconText } from '../../../guardrails/lexicon.ts';
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
  liveFunctionResponsePayload,
} from '../../../providers/google/live/framing.ts';
import { openGoogleLiveSession } from '../../../providers/google/live/session.ts';
import type { GoAwayClose, SessionQueueItem } from '../../../providers/google/live/stream.ts';
import type { ToolCredential } from '../../auth/types.ts';
import type { KernelRegistry } from '../../registry/kernel-registry.ts';
import { providerCompleteRequest } from '../../registry/provider-request.ts';
import { resolveTurnInRegistry } from '../../registry/resolve.ts';
import type { TurnStage } from '../../schema.ts';
import {
  type InjectUnit,
  injectedStageEvent,
  runStage,
  type StageCallBag,
  type StageHandler,
  stageEventFields,
} from '../../stages.ts';
import { profileAllowsInject, stageAbortStop } from '../../stop.ts';
import { failureEvent } from '../../tools/events.ts';
import { executeRegisteredTool, type ToolExecuteSettlement } from '../../tools/execute.ts';
import {
  answerGatedCall,
  gateExpired,
  resolveGateTtlMs,
  resumeForAnswer,
} from '../../tools/gate-answer.ts';
import { formatToolFailureForModel, formatToolResult } from '../../tools/model-text.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import { cloneTurnToolSnapshot } from '../../tools/resolve.ts';
import type {
  InvokeToolResume,
  ToolFailure,
  ToolGate,
  ToolPhaseEvent,
  TurnToolSnapshot,
} from '../../tools/types.ts';
import { type ProviderEvent, turnDoneOf } from '../../turn-events.ts';
import type {
  InteractionPart,
  LiveAnswerToolCallArgs,
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

export interface RunSessionOptions {
  gemini: GeminiTransport;
  /** Override socket open (Cloudflare fetch-upgrade, tests). Default: `new WebSocket(url)`. */
  openWebSocket?: (url: string) => Promise<WebSocket>;
  /**
   * Milliseconds a gated call waits for its decision (default 30 minutes). A later decision is
   * refused (`session.gate_expired`), and the model reads the call as abandoned.
   */
  gateTtlMs?: number;
}

type HeldCall = {
  name: string;
  arguments: Record<string, unknown>;
  /** `running` while `executeTool` runs it; a gated call waits for its decision. */
  state: 'open' | 'running' | { gate: ToolGate; createdAt: number };
};

type SettledPhase = Extract<ToolPhaseEvent, { phase: 'complete' | 'error' | 'gate' }>;

function isSettledPhase(tool: ToolPhaseEvent): tool is SettledPhase {
  return tool.phase === 'complete' || tool.phase === 'error' || tool.phase === 'gate';
}

/**
 * The provider's close after it warned of it (`goAway`): the session's last
 * event, not a failure. Every close fact rides along for the builder; the raw
 * close text is `errorInternal`, which `forClient` strips.
 */
function sessionEndedEvent(
  closed: Extract<SessionQueueItem, { type: 'closed' }>,
  goAway: GoAwayClose,
  lexicon: LexiconOverrides | undefined,
): TurnEvent {
  const internal = closed.error ? describeError(closed.error) : closed.reason;
  return {
    type: 'session',
    session: {
      kind: 'ended',
      ...(goAway.timeLeftMs !== undefined ? { timeLeftMs: goAway.timeLeftMs } : {}),
      message: lexiconText('live.session_ended', {}, lexicon),
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

/** Live ingress takes text: an inject's texts, or `undefined` when any message is not plain text. */
function liveInjectTexts(messages: readonly TurnHistoryMessage[]): string[] | undefined {
  const texts: string[] = [];
  for (const msg of messages) {
    const text = msg.role === 'tool' || msg.parts?.length ? undefined : msg.content?.trim();
    if (!text) return undefined;
    texts.push(text);
  }
  return texts;
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

/**
 * A provider batch as the host receives it: a call's `done` becomes the
 * host's (`turnDoneOf`); `response` stays with the trace, which read the batch.
 */
function hostEventsOf(events: readonly ProviderEvent[], snapshot: TurnToolSnapshot): TurnEvent[] {
  return events.flatMap((ev): TurnEvent[] => {
    if (ev.type === 'response') return [];
    if (ev.type !== 'done') return [ev];
    const { type: _done, ...done } = ev;
    return [turnDoneOf(done, snapshot)];
  });
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
  tools: ToolRegistry;
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
  openInitialCycle: boolean;
  trace: LiveTrace;
  gateTtlMs: number;
}): LiveSession {
  const {
    profile,
    canary,
    connection,
    gate,
    signal,
    onStage,
    host: sessionHost,
    resolveHost,
    path,
    snapshot,
    trace,
    gateTtlMs,
  } = args;
  /** Grows as the user approves `session_consent` tools. */
  let sessionPermissions = args.sessionPermissions;
  /** Grows as the user types keys at sign-in gates. */
  let sessionCredentials = args.credentials;
  const calls = new Map<string, HeldCall>();

  let closed = false;
  let withholdClose = false;
  const pendingHostEvents: TurnEvent[] = [];
  /** Wakes the host's stream when the session queues an event while Gemini is silent. */
  let wakeHost: (() => void) | undefined;
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

  const recordToolSettle = (
    tool: { name: string; callId: string; arguments: Record<string, unknown> },
    readBack: string,
  ) => {
    history.push(
      {
        role: 'assistant',
        tool_calls: [
          {
            id: tool.callId,
            type: 'function',
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: tool.callId,
        name: tool.name,
        content: readBack,
      },
    );
  };

  const enqueuePending = (ev: TurnEvent) => {
    pendingHostEvents.push(projectGuardrailTurnEvent(ev, includeMatch));
    const wake = wakeHost;
    wakeHost = undefined;
    wake?.();
  };

  const hostEventQueued = (): Promise<'queued'> =>
    pendingHostEvents.length > 0
      ? Promise.resolve('queued')
      : new Promise((resolve) => {
          wakeHost = () => resolve('queued');
        });

  const assertOpen = () => {
    if (closed) {
      throw new TheoremError('request', 'Live session is closed'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  };

  const sendJson = (payload: Record<string, unknown>) => {
    assertOpen();
    connection.send(payload);
  };

  const settleHeld = (callId: string, held: HeldCall, readBack: string) => {
    calls.delete(callId);
    recordToolSettle({ name: held.name, callId, arguments: held.arguments }, readBack);
    sendJson(buildGeminiLiveToolResponse(callId, held.name, readBack));
  };

  /**
   * Hold each call the model makes. A call the provider already failed
   * (malformed arguments) is settled here: the model reads its failure. A
   * provider cancel lets go of a call that is not running.
   */
  const holdCalls = (events: readonly ProviderEvent[]) => {
    for (const ev of events) {
      if (ev.type !== 'tool') continue;
      const tool = ev.tool;
      if (tool.phase === undefined) {
        calls.set(tool.callId, { name: tool.name, arguments: tool.arguments, state: 'open' });
        continue;
      }
      const held = calls.get(tool.callId);
      if (!held) continue;
      if (tool.phase === 'error' && tool.readBack !== undefined) {
        settleHeld(tool.callId, held, tool.readBack);
      } else if (tool.phase === 'cancel' && held.state !== 'running') {
        calls.delete(tool.callId);
      }
    }
  };

  const closeSocket = (code: number, reason: string, initiator: LiveCloser) => {
    trace.socketClosed(code, reason, initiator);
    connection.close(code, reason);
  };

  /** A `done` names the response span it ends. */
  const stampDone = (ev: TurnEvent): TurnEvent => {
    if (ev.type !== 'done') return ev;
    const traceparent = trace.responseTraceparent();
    return traceparent ? { ...ev, traceparent } : ev;
  };

  const runCycleStage = async (
    stage: TurnStage,
    extra?: StageCallBag,
  ): Promise<{ abort?: boolean | { reason?: string }; inject: InjectUnit[] }> => {
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
      inject: result.value.inject,
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

  /**
   * Write each inject whole into the open cycle (no re-entry into pre_turn),
   * then record the named ones that landed. An inject live cannot write as
   * text is refused whole with a stage warning, never written in part.
   */
  const landInject = (
    stage: TurnStage,
    units: readonly InjectUnit[],
    extra?: { callId?: string; toolName?: string },
  ) => {
    const landed: InjectUnit[] = [];
    for (const unit of units) {
      const texts = liveInjectTexts(unit.messages);
      if (!texts) {
        enqueuePending({
          ...stageEventFields(stage, extra),
          stageWarnings: [
            {
              code: 'inject_invalid_messages',
              field: 'inject',
              message: 'live ingress takes plain-text inject messages only; inject refused', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
            },
          ],
        });
        continue;
      }
      for (const text of texts) {
        assertLiveIngress(profile, 'text');
        ingestPreparedLiveText(text);
      }
      landed.push(unit);
    }
    const event = injectedStageEvent(stage, landed, extra);
    if (event) enqueuePending(event);
  };

  /** A stage's `abort` ends the open cycle: a cancelled `done`, then `post_turn`. */
  const cancelCycle = async (abort: true | { reason?: string }) => {
    const stop = stageAbortStop(abort);
    // Idle first, so a boundary Gemini sends meanwhile does not end the cycle again.
    cycle = 'idle';
    enqueuePending({ type: 'done', stop, interrupted: true });
    await runCycleStage('post_turn', { stop });
  };

  const openCycleIfNeeded = async (): Promise<{ aborted: boolean }> => {
    if (cycle === 'open') return { aborted: false };
    cycle = 'open';
    cycleStep += 1;
    const pre = await runCycleStage('pre_turn');
    if (pre.abort) {
      await cancelCycle(pre.abort);
      return { aborted: true };
    }
    landInject('pre_turn', pre.inject);
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
    landInject('before_end', before.inject);
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

  /**
   * Run a held call through the registry, with stages. A gate holds it for its
   * decision; any other settlement answers the model and lets it go.
   */
  const runHeld = async (
    callId: string,
    held: HeldCall,
    input: unknown,
    resume: InvokeToolResume | undefined,
    per: Pick<LiveExecuteToolArgs, 'credentials' | 'host'>,
  ): Promise<LiveExecuteToolResult> => {
    const waiting = held.state;
    held.state = 'running';
    const host = per.host ?? sessionHost;
    const record = trace.toolRecord(callId);
    const exec = executeRegisteredTool({
      tools: args.tools,
      profile,
      name: held.name,
      input,
      callId,
      ctx: {
        sessionPermissions,
        credentials: per.credentials ?? sessionCredentials,
        resolveHost,
        path,
        signal,
        resume,
        host,
        turn: { step: Math.max(1, cycleStep) },
      },
      snapshot,
      stages: {
        handlers: onStage ? [onStage] : [],
        profile,
        step: Math.max(1, cycleStep),
        history: () => history,
        injectAllowed: profileAllowsInject(profile),
        host,
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
    } catch (err) {
      // It did not settle: it waits as it did, to be run again.
      held.state = waiting;
      throw err;
    } finally {
      record.finish();
    }

    if (s.gated) {
      held.state = { gate: s.gated, createdAt: Date.now() };
      return { gated: s.gated };
    }

    if (s.aborted) {
      // A stage stopped the call. The model still reads an answer, or it
      // waits for one; then the open cycle ends cancelled, as a turn does.
      const failure: ToolFailure | undefined = s.callNotStarted
        ? {
            code: 'cancelled',
            kind: 'cancelled',
            message: lexiconText('session.tool_aborted', { tool: held.name }, profile.lexicon),
          }
        : s.failure;
      if (s.callNotStarted && failure) {
        const readBack = formatToolResult(formatToolFailureForModel(failure));
        enqueuePending(failureEvent({ name: held.name, callId }, failure, readBack));
        settleHeld(callId, held, readBack);
      } else {
        const output = liveToolOutput(s);
        if (output === undefined) calls.delete(callId);
        else settleHeld(callId, held, output);
      }
      const { aborted } = s;
      await withIngress(async () => {
        if (cycle === 'open') await cancelCycle(aborted);
      });
      return {
        outputRaw: s.outputRaw,
        outputModel: s.modelResult,
        failure,
        awaiting: s.awaiting,
      };
    }

    const { pendingInject } = s;
    if (pendingInject) {
      await withIngress(async () => {
        const opened = await openCycleIfNeeded();
        if (opened.aborted) return;
        landInject('post_tool', pendingInject, { callId, toolName: held.name });
      });
    }

    const output = liveToolOutput(s);
    if (output === undefined) calls.delete(callId);
    else settleHeld(callId, held, output);

    return {
      outputRaw: s.outputRaw,
      outputModel: s.modelResult,
      failure: s.failure,
      awaiting: s.awaiting,
    };
  };

  /**
   * The held call `callId`, when it can run now. A gate that waited past
   * `gateTtlMs` is settled as abandoned (the model reads that), then refused.
   */
  const takeHeld = async (callId: string): Promise<HeldCall> => {
    const held = calls.get(callId);
    if (!held || held.state === 'running') {
      throw new TheoremError('request', `call ${callId} is not waiting to run`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    if (
      typeof held.state === 'object' &&
      gateExpired(held.state.createdAt, Date.now(), gateTtlMs)
    ) {
      await runHeld(callId, held, held.arguments, resumeForAnswer({ decision: 'abandon' }), {});
      // lexicon-exempt: developer contract / internal diagnostic — the user reads session.gate_expired
      throw new TheoremError('request', `gate ${callId} expired`, {
        copy: { key: 'session.gate_expired' },
      });
    }
    return held;
  };

  const deliverBatch = async function* (
    item: Extract<SessionQueueItem, { type: 'batch' }>,
  ): AsyncGenerator<TurnEvent> {
    holdCalls(item.events);
    // Usage is held per response and emitted once, reported or estimated, by `settle`.
    const gated = await applyOutbound(
      gate,
      hostEventsOf(
        item.events.filter((ev) => ev.type !== 'tokens'),
        snapshot,
      ),
      item.turnPhase,
      () => {
        withholdClose = true;
      },
    );
    for (const ev of gated) {
      if (ev.type === 'guardrail') trace.outbound(ev);
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
  };

  const streamToHost = async function* (): AsyncGenerator<TurnEvent> {
    // Who closes the socket when the loop ends: the host, unless THEOREM stops it.
    let closer: LiveCloser = 'host';
    let thrown: unknown;
    const provider = connection.batches();
    // The batch being awaited; it stays pending across wakes, so no frame is read twice.
    let nextBatch: Promise<IteratorResult<SessionQueueItem>> | undefined;
    try {
      while (true) {
        nextBatch ??= provider.next();
        // A tool the host ran, or a stage the session fired, reaches the host
        // now: a model waiting on a call's result sends nothing meanwhile.
        const woke = await Promise.race([nextBatch, hostEventQueued()]);
        throwIfAborted(signal);
        if (woke === 'queued') {
          yield* drainPendingHostEvents(pendingHostEvents);
          continue;
        }
        nextBatch = undefined;
        if (woke.done) break;
        const item = woke.value;
        trace.receive(item);
        yield* drainPendingHostEvents(pendingHostEvents);
        if (item.type === 'closed') {
          if (item.goAway) yield sessionEndedEvent(item, item.goAway, profile.lexicon);
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
        yield* deliverBatch(item);

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
      // The socket is closed, so a batch still awaited resolves and the provider can finish.
      await provider.return(undefined);
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
    async executeTool({
      callId,
      decision,
      input,
      secret,
      credentials,
      host,
    }: LiveExecuteToolArgs): Promise<LiveExecuteToolResult> {
      assertOpen();
      const held = await takeHeld(callId);
      const gate = typeof held.state === 'object' ? held.state.gate : undefined;
      if (!gate) {
        if (decision !== undefined || input !== undefined || secret !== undefined) {
          throw new TheoremError(
            'request',
            `call ${callId} is not waiting on a gate; it takes no decision, input or secret`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
          );
        }
        return await runHeld(callId, held, held.arguments, undefined, { credentials, host });
      }
      if (decision === undefined) {
        throw new TheoremError(
          'request',
          `call ${callId} is waiting on a gate; answer it with a decision`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        );
      }
      const answered = answerGatedCall(
        { callId, decision, input, secret },
        {
          name: held.name,
          arguments: held.arguments,
          permission: gate.permission,
          ...(gate.kind === 'auth' ? { auth: gate.authChallenge } : {}),
        },
        sessionPermissions ?? [],
      );
      if (answered.typed) {
        sessionCredentials = {
          ...sessionCredentials,
          [answered.typed.slot]: answered.typed.credential,
        };
      }
      sessionPermissions = answered.sessionPermissions;
      return await runHeld(callId, held, answered.input, answered.resume, {
        credentials,
        host,
      });
    },
    answerToolCall({ callId, events }: LiveAnswerToolCallArgs): LiveExecuteToolResult {
      assertOpen();
      const held = calls.get(callId);
      if (held?.state !== 'open') {
        throw new TheoremError('request', `call ${callId} is not waiting for an answer`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      }
      let settled: SettledPhase | undefined;
      for (const ev of events) {
        if (ev.type !== 'tool') continue;
        if (ev.tool.phase === undefined || ev.tool.callId !== callId) {
          throw new TheoremError(
            'request',
            `the run answering call ${callId} carries a call of its own (${ev.tool.callId})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
          );
        }
        if (isSettledPhase(ev.tool)) settled = ev.tool;
      }
      if (!settled) {
        throw new TheoremError('request', `the run answering call ${callId} settled nothing`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      }
      const forward = () => {
        for (const ev of events) {
          if (ev.type !== 'done') enqueuePending(ev);
        }
      };
      if (settled.phase === 'gate') {
        forward();
        return { gated: settled.gate };
      }
      const { readBack } = settled;
      if (readBack === undefined) {
        throw new TheoremError('request', `the run answering call ${callId} carries no readBack`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      }
      forward();
      settleHeld(callId, held, readBack);
      return settled.phase === 'complete'
        ? { outputRaw: settled.output, ...(settled.awaiting ? { awaiting: true } : {}) }
        : { failure: settled.failure };
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
 * The session record is written however the session ends, including when opening fails. An unknown
 * profile fails to open and is recorded under the standard observability policy.
 */
export async function runSessionInRegistry(
  registry: KernelRegistry,
  req: SessionRequest,
  options: RunSessionOptions,
  sinkOverride?: TraceSink,
): Promise<LiveSession> {
  const trace = startLiveTrace(
    req,
    registry.profiles.find(req.profile)?.observability,
    sinkOverride,
  );
  try {
    return await openTracedSession(registry, req, options, trace);
  } catch (err) {
    await trace.close({ thrown: err });
    throw err;
  }
}

async function openTracedSession(
  registry: KernelRegistry,
  req: SessionRequest,
  options: RunSessionOptions,
  trace: LiveTrace,
): Promise<LiveSession> {
  const gateTtlMs = resolveGateTtlMs('runSession', options.gateTtlMs);
  const turnReq = toTurnRequest(req);
  const safe = sanitizeTurnRequest(turnReq, registry.profiles.get(turnReq.profile));
  throwIfAborted(safe.signal);

  const { profile, generation: gen0 } = resolveTurnInRegistry(registry, safe);
  assertLiveProfile(profile);

  if (req.snapshot) {
    gen0.tools = sessionSnapshotWithinAllow(profile, req.snapshot);
  }
  gen0.builtins = gen0.tools.builtins;

  let generation = applyVoiceOverride(gen0, req.voice);
  const hasInitialInput = Boolean(req.input && req.input.length > 0);
  generation = applyInitialInput(generation, req.input);

  const system = bindUserDataNote(
    bindCanary(generation.resolvedSystem, generation.canary, profile.lexicon),
    profile.lexicon,
  );
  const completeReq: ProviderCompleteRequest = {
    ...providerCompleteRequest(registry.tools, generation, system),
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

  const gate = createLiveOutboundGateSession(profile, generation.canary || undefined);
  const connection = await openGoogleLiveSession(
    completeReq,
    options.gemini,
    options.openWebSocket,
  );
  trace.setup(connection.setup);

  return buildLiveSession({
    tools: registry.tools,
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
    gateTtlMs,
  });
}
