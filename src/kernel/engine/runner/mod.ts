/**
 * Deterministic turn runner for THEORUM.
 *
 * `runTurn` resolves a profile, sanitizes input, binds canary boundaries,
 * streams provider events, executes allowed tools, applies validation and
 * egress repair loops, writes traces, and emits one terminal `done` event.
 *
 * @module
 */

import { bindCanary } from '../../../guardrails/canary.ts';
import { isAbortError, throwIfAborted } from '../../../guardrails/error.ts';
import { projectGuardrailTurnEvent } from '../../../guardrails/events.ts';
import { sanitizeTurnRequestWithEvents } from '../../../guardrails/sanitize.ts';
import { resolveTraceWriter } from '../../../observability/policy.ts';
import { noopSink, writeTrace } from '../../../observability/trace.ts';
import { buildRecord } from '../../../observability/trace-record.ts';
import type { TraceSink } from '../../../observability/trace-sink.ts';
import type { ResolvedObservabilityPolicy } from '../../../observability/types.ts';
import { getProfile } from '../../registry/profiles.ts';
import { resolveTurn } from '../../registry/resolve.ts';
import type { Protocol } from '../../schema.ts';
import { cloneTurnToolSnapshot, expandT1Policy } from '../../tools/resolve.ts';
import type {
  CompactionSignal,
  CompactionSpec,
  ModelProfile,
  ModelProvider,
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
} from '../../types.ts';
import { resolveCompactionTokens, shouldCompact, splitForCompaction } from '../compaction.ts';
import { runAttemptsWithValidation } from './gates.ts';
import { applyTurnStage } from './stages.ts';
import type { StepExecutionState } from './state.ts';
import { shouldSkipStreamEvent } from './stream.ts';
import { calculateFallbackTokens } from './tokens.ts';

function projectForObs(
  event: TurnEvent,
  policy: ResolvedObservabilityPolicy | undefined,
): TurnEvent {
  return projectGuardrailTurnEvent(event, policy?.include.guardrailMatchPreview ?? false);
}

function getCompactionSpec(profile: ModelProfile, modelId: string): CompactionSpec | undefined {
  return profile.models[modelId]?.compaction;
}

/** Fold one history message to a compaction transcript line (media → markers). */
function compactionTranscriptLine(m: TurnHistoryMessage): string {
  const text = m.content ?? '';
  const mediaMarkers =
    m.parts
      ?.filter((p) => p.type !== 'text')
      .map((p) => `[${p.type}]`)
      .join('') ?? '';
  const fromTextParts =
    !text && m.parts
      ? m.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('')
      : '';
  const content = `${text || fromTextParts}${mediaMarkers}`;
  return `[${m.role}]: ${content}`;
}

async function runCompactionTurn(
  toCompact: TurnHistoryMessage[],
  spec: CompactionSpec,
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<TurnHistoryMessage> {
  const compactText = toCompact.map(compactionTranscriptLine).join('\n');

  const events: TurnEvent[] = [];
  for await (const event of runTurn(
    {
      profile: spec.profile,
      input: { text: compactText },
      signal,
      metadata: { _compacting: true },
    },
    provider,
  )) {
    events.push(event);
  }

  const structured = events.find((e) => e.type === 'structured')?.structured;
  const text = structured
    ? JSON.stringify(structured)
    : events
        .filter((e) => e.type === 'text')
        .map((e) => e.text ?? '')
        .join('');

  return {
    role: 'assistant',
    content: text,
    metadata: { compactionSummary: true },
  };
}

function lastTokensFromEvents(events: TurnEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const input = events[i]?.tokens?.input;
    if (input) return input;
  }
  return 0;
}

async function compactHistoryBeforeTurn(args: {
  spec: CompactionSpec;
  history: TurnHistoryMessage[];
  input: TurnRequest['input'];
  provider: ModelProvider;
  compactionProvider?: ModelProvider;
  signal?: AbortSignal;
}): Promise<TurnHistoryMessage[]> {
  const decision = await resolveCompactionTokens({
    spec: args.spec,
    input: args.input,
  });
  if (!(decision && (await shouldCompact(decision, args.spec)))) return args.history;
  const { toCompact, toRetain } = await splitForCompaction(args.history, args.spec);
  if (toCompact.length === 0) return args.history;
  const summaryMessage = await runCompactionTurn(
    toCompact,
    args.spec,
    args.compactionProvider ?? args.provider,
    args.signal,
  );
  return [summaryMessage, ...toRetain];
}

async function attachAfterCompaction(
  event: TurnEvent,
  args: {
    spec: CompactionSpec;
    history: TurnHistoryMessage[];
    input: TurnRequest['input'];
    seen: TurnEvent[];
  },
): Promise<TurnEvent> {
  if (args.history.length === 0) return event;
  const promptTokens = lastTokensFromEvents(args.seen);
  const decision = await resolveCompactionTokens({
    spec: args.spec,
    input: args.input,
    promptTokens,
  });
  if (!(decision && (await shouldCompact(decision, args.spec)))) return event;
  const signal: CompactionSignal = {
    needed: true,
    meter: decision.meter,
    tokens: decision.tokens,
    history: args.history,
  };
  if (promptTokens > 0) signal.promptTokens = promptTokens;
  return { ...event, compaction: signal };
}

async function* emitTurn(args: {
  safe: TurnRequest;
  profile: Profile;
  generation: ResolvedGeneration;
  system: string;
  provider: ModelProvider;
  upstream: Record<string, unknown>[];
  /** Filled before the terminal `done` so callers can run `post_turn` after compaction-after. */
  outState: { state?: StepExecutionState };
}): AsyncGenerator<TurnEvent> {
  const { safe, profile, generation, system, provider, upstream } = args;

  const state: StepExecutionState = {
    currentHistory: [...(generation.history ?? [])],
    stepCount: 0,
    sawTokensEvent: false,
    allEmittedEvents: [],
    attemptEvents: [],
  };
  args.outState.state = state;

  const pre = yield* applyTurnStage({
    profile,
    generation,
    state,
    stage: 'pre_turn',
    step: 1,
    onStage: safe.onStage,
    signal: safe.signal,
    foldInput: true,
    host: generation.host,
  });
  if (pre.abort) {
    const stop = {
      kind: 'cancelled' as const,
      ...(typeof pre.abort === 'object' && pre.abort.reason ? { native: pre.abort.reason } : {}),
    };
    const done: TurnEvent = { type: 'done', stop };
    state.allEmittedEvents.push(done);
    yield done;
    yield* applyTurnStage({
      profile,
      generation,
      state,
      stage: 'post_turn',
      step: 1,
      onStage: safe.onStage,
      signal: safe.signal,
      stop,
      host: generation.host,
    });
    return;
  }

  yield* runAttemptsWithValidation(safe, profile, generation, system, provider, upstream, state);

  if (!state.sawTokensEvent) {
    yield* calculateFallbackTokens(safe, system, state.allEmittedEvents);
  }

  const stop = state.lastStop ?? { kind: 'completed' };
  const done: TurnEvent = {
    type: 'done',
    stop,
    ...(stop.kind === 'tool' && state.toolSnapshot
      ? { tools: cloneTurnToolSnapshot(state.toolSnapshot) }
      : {}),
    ...(stop.kind === 'gate' && state.toolSnapshot
      ? { tools: cloneTurnToolSnapshot(state.toolSnapshot) }
      : {}),
  };
  state.allEmittedEvents.push(done);
  yield done;
}

async function* streamTurnEvents(
  ctx: TraceCtx,
  profile: Profile,
  gen: ResolvedGeneration,
  provider: ModelProvider,
  compactionSpec: CompactionSpec | undefined,
  isCompacting: boolean,
): AsyncGenerator<TurnEvent> {
  if (!ctx.safe || ctx.system === undefined) return;
  const outState: { state?: StepExecutionState } = {};
  for await (const event of emitTurn({
    safe: ctx.safe,
    profile,
    generation: gen,
    system: ctx.system,
    provider,
    upstream: ctx.upstream,
    outState,
  })) {
    const attached = await maybeAttachAfter(event, ctx, gen, compactionSpec, isCompacting);
    const out = projectForObs(attached, ctx.observability);
    ctx.seen.push(out);
    if (!shouldSkipStreamEvent(out, profile)) yield out;

    if (out.type === 'done' && outState.state) {
      // Skip duplicate post_turn when pre_turn abort already emitted it inside emitTurn.
      const alreadyPost = outState.state.allEmittedEvents.some(
        (e) => e.type === 'stage' && e.stage === 'post_turn',
      );
      if (!alreadyPost) {
        for await (const stageEv of applyTurnStage({
          profile,
          generation: gen,
          state: outState.state,
          stage: 'post_turn',
          step: Math.max(outState.state.stepCount, 1),
          onStage: ctx.safe.onStage,
          signal: ctx.safe.signal,
          stop: out.stop,
          host: gen.host,
        })) {
          const stageOut = projectForObs(stageEv, ctx.observability);
          ctx.seen.push(stageOut);
          if (!shouldSkipStreamEvent(stageOut, profile)) yield stageOut;
        }
      }
    }
  }
}

type TraceCtx = {
  req: TurnRequest;
  seen: TurnEvent[];
  started: number;
  model?: string;
  keySlot?: string;
  canary: string;
  system?: string;
  generation?: ResolvedGeneration;
  protocol?: Protocol;
  safe?: TurnRequest;
  upstream: Record<string, unknown>[];
  thrown?: unknown;
  observability?: ResolvedObservabilityPolicy;
};

async function flushTurnTrace(sink: TraceSink, ctx: TraceCtx): Promise<void> {
  await writeTrace(
    sink,
    buildRecord({
      req: ctx.req,
      events: ctx.seen,
      started: ctx.started,
      model: ctx.model,
      keySlot: ctx.keySlot,
      thrown: ctx.thrown,
      upstreamLog: ctx.upstream,
      canary: ctx.canary,
      system: ctx.system,
      generation: ctx.generation,
      protocol: ctx.protocol,
      sanitizedReq: ctx.safe,
      observability: ctx.observability,
    }),
  );
}

/** Execute one host turn against a provider adapter. */
async function* runTurn(
  req: TurnRequest,
  provider: ModelProvider,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  const ctx: TraceCtx = {
    req,
    seen: [],
    started: Date.now(),
    canary: '',
    upstream: [],
  };
  let sink: TraceSink = sinkOverride ?? noopSink();
  try {
    const profile = getProfile(req.profile);
    const resolved = resolveTraceWriter({
      override: sinkOverride,
      observability: profile.observability,
    });
    sink = resolved.sink;
    ctx.observability = resolved.policy;
    yield* runTurnBody(ctx, provider);
  } catch (err) {
    if (isAbortError(err)) {
      yield* emitCancelledDoneAfterAbort(ctx);
      await flushTurnTrace(sink, { ...ctx, thrown: err });
      return;
    }
    await flushTurnTrace(sink, { ...ctx, thrown: err });
    throw err;
  }
  await flushTurnTrace(sink, ctx);
}

/**
 * Slice 1: host AbortSignal ends with cancelled `done` + `post_turn`, not a bare throw.
 * Skip when a terminal `done` already reached the host stream.
 */
async function* emitCancelledDoneAfterAbort(ctx: TraceCtx): AsyncGenerator<TurnEvent> {
  if (ctx.seen.some((e) => e.type === 'done')) return;
  const stop = { kind: 'cancelled' as const };
  const done: TurnEvent = { type: 'done', stop };
  const outDone = projectForObs(done, ctx.observability);
  ctx.seen.push(outDone);
  yield outDone;

  const profile = getProfile(ctx.req.profile);
  const gen = ctx.generation;
  if (!gen || !ctx.safe) return;

  const state: StepExecutionState = {
    currentHistory: [...(gen.history ?? [])],
    stepCount: 0,
    sawTokensEvent: false,
    allEmittedEvents: [...ctx.seen],
    attemptEvents: [],
  };
  for await (const stageEv of applyTurnStage({
    profile,
    generation: gen,
    state,
    stage: 'post_turn',
    step: 1,
    onStage: ctx.safe.onStage,
    stop,
    host: gen.host,
  })) {
    const stageOut = projectForObs(stageEv, ctx.observability);
    ctx.seen.push(stageOut);
    if (!shouldSkipStreamEvent(stageOut, profile)) yield stageOut;
  }
}

async function* runTurnBody(ctx: TraceCtx, provider: ModelProvider): AsyncGenerator<TurnEvent> {
  const sanitized = sanitizeTurnRequestWithEvents(ctx.req);
  ctx.safe = sanitized.request;
  for (const event of sanitized.events) {
    const out = projectForObs(event, ctx.observability);
    ctx.seen.push(out);
    yield out;
  }
  const { profile, generation: gen } = resolveTurn(ctx.safe);
  await expandT1Policy(gen.tools, profile, ctx.safe);
  gen.builtins = gen.tools.builtins;
  ctx.generation = gen;
  ctx.model = gen.model;
  ctx.keySlot = gen.keySlot;
  ctx.canary = gen.canary;
  ctx.protocol = profile.models[gen.model]?.protocol;

  throwIfAborted(ctx.safe.signal);

  const isCompacting = ctx.req.metadata?._compacting === true;
  const compactionSpec = isCompacting ? undefined : getCompactionSpec(profile, gen.model);
  await maybeCompactBefore(ctx, gen, compactionSpec, provider);

  ctx.system = bindCanary(gen.resolvedSystem, ctx.canary);

  yield* streamTurnEvents(ctx, profile, gen, provider, compactionSpec, isCompacting);
}

async function maybeCompactBefore(
  ctx: TraceCtx,
  gen: ResolvedGeneration,
  compactionSpec: CompactionSpec | undefined,
  provider: ModelProvider,
): Promise<void> {
  if (!(compactionSpec?.timing === 'before' && gen.history?.length && ctx.safe)) return;
  gen.history = await compactHistoryBeforeTurn({
    spec: compactionSpec,
    history: gen.history,
    input: ctx.safe.input,
    provider,
    compactionProvider: ctx.req.compactionProvider,
    signal: ctx.safe.signal,
  });
}

async function maybeAttachAfter(
  event: TurnEvent,
  ctx: TraceCtx,
  gen: ResolvedGeneration,
  compactionSpec: CompactionSpec | undefined,
  isCompacting: boolean,
): Promise<TurnEvent> {
  if (!(event.type === 'done' && compactionSpec?.timing === 'after' && !isCompacting && ctx.safe)) {
    return event;
  }
  return await attachAfterCompaction(event, {
    spec: compactionSpec,
    history: gen.history ?? [],
    input: ctx.safe.input,
    seen: ctx.seen,
  });
}

export { compactionTranscriptLine, runTurn };
