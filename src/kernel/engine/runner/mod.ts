/**
 * Deterministic turn runner for THEOREM.
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
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { sanitizeTurnRequestWithEvents } from '../../../guardrails/sanitize.ts';
import { resolveTraceWriter } from '../../../observability/policy.ts';
import { resolveObservabilityPolicy } from '../../../observability/resolve-policy.ts';
import { writeTrace } from '../../../observability/trace.ts';
import { buildRecord } from '../../../observability/trace-record.ts';
import type { TraceSink } from '../../../observability/trace-sink.ts';
import {
  type SpanHandle,
  startTrace,
  type TraceAttributes,
  traceContent,
} from '../../../observability/trace-span.ts';
import type { ResolvedObservabilityPolicy } from '../../../observability/types.ts';
import { getProfile, profileObservability } from '../../registry/profiles.ts';
import { resolveTurn } from '../../registry/resolve.ts';
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
  TurnTokens,
} from '../../types.ts';
import {
  type CompactionTokens,
  compactionMeter,
  resolveCompactionTokens,
  shouldCompact,
  splitForCompaction,
} from '../compaction.ts';
import { type MediaTokenFamily, mediaTokenFamily } from '../token-estimate.ts';
import { endTurnSpan, guardrailAttributes, OutputFold, turnSpanOptions } from '../turn-trace.ts';
import { runAttemptsWithValidation } from './gates.ts';
import { applyTurnStage } from './stages.ts';
import { openTurnState, type StepExecutionState, type TurnTraceState } from './state.ts';
import { shouldSkipStreamEvent } from './stream.ts';

function projectForObs(
  event: TurnEvent,
  policy: ResolvedObservabilityPolicy | undefined,
): TurnEvent {
  return projectGuardrailTurnEvent(event, policy?.include.guardrailMatchPreview ?? false);
}

/** Record an event as delivered to the host; every yield to the host passes through here. */
function deliver(ctx: TraceCtx, out: TurnEvent): TurnEvent {
  ctx.seen.push(out);
  ctx.delivered.add(out, ctx.root.nowUnixNano());
  return out;
}

function* emitObservedStage(
  ctx: TraceCtx,
  stageEv: TurnEvent,
  profile: Profile,
): Generator<TurnEvent> {
  const stageOut = projectForObs(stageEv, ctx.observability);
  if (shouldSkipStreamEvent(stageOut, profile)) return;
  yield deliver(ctx, stageOut);
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

/**
 * Run the compaction profile as a turn nested under `parent`: its spans join
 * the parent's record and it writes none of its own.
 */
async function runCompactionTurn(
  toCompact: TurnHistoryMessage[],
  spec: CompactionSpec,
  provider: ModelProvider,
  parent: SpanHandle,
  canaries: string[],
  signal?: AbortSignal,
): Promise<TurnHistoryMessage> {
  const compactText = toCompact.map(compactionTranscriptLine).join('\n');
  const req: TurnRequest = { profile: spec.profile, input: { text: compactText }, signal };
  const ctx = newTraceCtx(
    req,
    parent.child(`invoke_agent ${req.profile}`, turnSpanOptions(req)),
    canaries,
  );
  ctx.compacting = true;
  ctx.observability = resolveObservabilityPolicy(profileObservability(req.profile));

  const events: TurnEvent[] = [];
  for await (const event of runTracedTurn(ctx, provider)) {
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

function lastTokensFromEvents(events: TurnEvent[]): TurnTokens | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const tokens = events[i]?.tokens;
    if (tokens) return tokens;
  }
  return undefined;
}

/**
 * One compaction decision as `theorem.compaction` attributes. The metered count
 * is absent when it is unknown (meter `input` with no count to read).
 */
function compactionDecision(
  spec: CompactionSpec,
  decision: CompactionTokens | undefined,
  needed: boolean,
): TraceAttributes {
  return {
    timing: spec.timing,
    meter: compactionMeter(spec),
    budget: spec.maxTokens,
    threshold: spec.compactAt,
    ...(spec.trigger ? { trigger: 'custom' } : {}),
    ...(decision ? { tokens_before: decision.tokens, unknown_media: decision.unknownMedia } : {}),
    needed,
  };
}

async function compactHistoryBeforeTurn(args: {
  spec: CompactionSpec;
  family: MediaTokenFamily | undefined;
  history: TurnHistoryMessage[];
  input: TurnRequest['input'];
  provider: ModelProvider;
  compactionProvider?: ModelProvider;
  parent: SpanHandle;
  canaries: string[];
  signal?: AbortSignal;
}): Promise<TurnHistoryMessage[]> {
  const decision = await resolveCompactionTokens({
    spec: args.spec,
    input: args.input,
    family: args.family,
  });
  const needed = decision !== undefined && (await shouldCompact(decision, args.spec));
  const attributes = compactionDecision(args.spec, decision, needed);
  if (!needed) {
    args.parent.event('theorem.compaction', attributes);
    return args.history;
  }
  const { toCompact, toRetain } = await splitForCompaction(args.history, args.spec, args.family);
  if (toCompact.length === 0) {
    args.parent.event('theorem.compaction', { ...attributes, compacted: false });
    return args.history;
  }
  const summaryMessage = await runCompactionTurn(
    toCompact,
    args.spec,
    args.compactionProvider ?? args.provider,
    args.parent,
    args.canaries,
    args.signal,
  );
  const compacted = [summaryMessage, ...toRetain];
  args.parent.event('theorem.compaction', {
    ...attributes,
    compacted: true,
    messages_before: args.history.length,
    messages_after: compacted.length,
    summary: traceContent(summaryMessage.content ?? ''),
  });
  return compacted;
}

async function attachAfterCompaction(
  event: TurnEvent,
  args: {
    spec: CompactionSpec;
    family: MediaTokenFamily | undefined;
    history: TurnHistoryMessage[];
    input: TurnRequest['input'];
    seen: TurnEvent[];
    /** The turn's root, where the decision is recorded. */
    span: SpanHandle;
  },
): Promise<TurnEvent> {
  if (args.history.length === 0) return event;
  const prompt = lastTokensFromEvents(args.seen);
  const decision = await resolveCompactionTokens({
    spec: args.spec,
    input: args.input,
    prompt,
    family: args.family,
  });
  const needed = decision !== undefined && (await shouldCompact(decision, args.spec));
  args.span.event('theorem.compaction', compactionDecision(args.spec, decision, needed));
  if (!(needed && decision)) return event;
  const signal: CompactionSignal = {
    needed: true,
    meter: decision.meter,
    tokens: decision.tokens,
    unknownMedia: decision.unknownMedia,
    history: args.history,
  };
  if (prompt && prompt.input > 0) {
    signal.promptTokens = prompt.input;
    if (prompt.estimated?.includes('input')) signal.promptTokensEstimated = true;
  }
  return { ...event, compaction: signal };
}

async function* emitTurn(args: {
  safe: TurnRequest;
  profile: Profile;
  generation: ResolvedGeneration;
  system: string;
  provider: ModelProvider;
  trace: TurnTraceState;
  mediaFamily: MediaTokenFamily | undefined;
  /** Filled when the turn opens, so `post_turn` (after compaction-after, or after an abort) reuses it. */
  outState: { state?: StepExecutionState };
}): AsyncGenerator<TurnEvent> {
  const { safe, profile, generation, system, provider } = args;

  const state = openTurnState({
    profile,
    generation,
    trace: args.trace,
    mediaFamily: args.mediaFamily,
  });
  args.outState.state = state;

  const pre = yield* applyTurnStage({
    profile,
    generation,
    state,
    stage: 'pre_turn',
    step: 1,
    onStage: safe.onStage,
    signal: safe.signal,
    host: generation.host,
  });
  if (pre.abort) {
    const stop = {
      kind: 'cancelled' as const,
      ...(typeof pre.abort === 'object' && pre.abort.reason ? { native: pre.abort.reason } : {}),
    };
    const done: TurnEvent = { type: 'done', stop, traceparent: state.trace.root.traceparent() };
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

  yield* runAttemptsWithValidation(safe, profile, generation, system, provider, state);

  const stop = state.lastStop ?? { kind: 'completed' };
  const done: TurnEvent = {
    type: 'done',
    stop,
    traceparent: state.trace.root.traceparent(),
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
): AsyncGenerator<TurnEvent> {
  if (!ctx.safe || ctx.system === undefined || !ctx.trace) return;
  for await (const event of emitTurn({
    safe: ctx.safe,
    profile,
    generation: gen,
    system: ctx.system,
    provider,
    trace: ctx.trace,
    mediaFamily: ctx.mediaFamily,
    outState: ctx,
  })) {
    const attached = await maybeAttachAfter(event, ctx, gen, compactionSpec);
    const out = projectForObs(attached, ctx.observability);
    if (!shouldSkipStreamEvent(out, profile)) yield deliver(ctx, out);

    if (out.type === 'done' && ctx.state) {
      // Skip duplicate post_turn when pre_turn abort already emitted it inside emitTurn.
      const alreadyPost = ctx.state.allEmittedEvents.some(
        (e) => e.type === 'stage' && e.stage === 'post_turn',
      );
      if (!alreadyPost) {
        for await (const stageEv of applyTurnStage({
          profile,
          generation: gen,
          state: ctx.state,
          stage: 'post_turn',
          step: Math.max(ctx.state.stepCount, 1),
          onStage: ctx.safe.onStage,
          signal: ctx.safe.signal,
          stop: out.stop,
          host: gen.host,
        })) {
          yield* emitObservedStage(ctx, stageEv, profile);
        }
      }
    }
  }
}

type TraceCtx = {
  req: TurnRequest;
  /** Every event the host received. */
  seen: TurnEvent[];
  /** The same events as output parts. */
  delivered: OutputFold;
  /** This turn's `invoke_agent` span. */
  root: SpanHandle;
  /** Step-state trace handle, once the turn's model binding is known. */
  trace?: TurnTraceState;
  /** True for the compaction profile's own nested turn, which never compacts. */
  compacting: boolean;
  /** Compaction ran before this turn's first call. */
  compacted: boolean;
  canary: string;
  /** Every canary bound in this record; a nested turn shares its parent's list. */
  canaries: string[];
  system?: string;
  generation?: ResolvedGeneration;
  mediaFamily?: MediaTokenFamily;
  safe?: TurnRequest;
  observability?: ResolvedObservabilityPolicy;
  /** The turn's step state once `emitTurn` opened it. */
  state?: StepExecutionState;
};

function newTraceCtx(req: TurnRequest, root: SpanHandle, canaries: string[] = []): TraceCtx {
  return {
    req,
    seen: [],
    delivered: new OutputFold(),
    root,
    compacting: false,
    compacted: false,
    canary: '',
    canaries,
  };
}

/** Close the turn's span from what the host saw and what the step state counted. */
function endTurn(ctx: TraceCtx, thrown?: unknown): void {
  const calls = ctx.trace?.calls ?? 0;
  endTurnSpan(ctx.root, {
    seen: ctx.seen,
    delivered: ctx.delivered,
    attempts: calls > 0 ? (ctx.trace?.attempt ?? 0) + 1 : 0,
    calls,
    compacted: ctx.compacted,
    ...(thrown === undefined ? {} : { thrown }),
  });
}

/** Run a turn under `ctx.root` and close it; an abort ends as a cancelled `done`. */
async function* runTracedTurn(ctx: TraceCtx, provider: ModelProvider): AsyncGenerator<TurnEvent> {
  try {
    yield* runTurnBody(ctx, provider);
  } catch (err) {
    if (isAbortError(err)) {
      yield* emitCancelledDoneAfterAbort(ctx);
      endTurn(ctx);
      return;
    }
    endTurn(ctx, err);
    throw err;
  }
  endTurn(ctx);
}

/**
 * Execute one host turn against a provider adapter and write its trace record.
 *
 * The record is written however the turn ends, including when the host stops
 * reading early; spans still open then close as `ERROR` / `unclosed`.
 */
async function* runTurn(
  req: TurnRequest,
  provider: ModelProvider,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  const { sink, policy } = resolveTraceWriter({
    override: sinkOverride,
    observability: profileObservability(req.profile),
  });
  const tree = startTrace(`invoke_agent ${req.profile}`, {
    ...turnSpanOptions(req),
    ...(req.traceparent ? { traceparent: req.traceparent } : {}),
  });
  const ctx = newTraceCtx(req, tree.root);
  ctx.observability = policy;
  try {
    yield* runTracedTurn(ctx, provider);
  } finally {
    await writeTrace(
      sink,
      buildRecord({
        spans: tree.collect(),
        policy,
        canaries: ctx.canaries,
        ...(req.metadata ? { metadata: req.metadata } : {}),
      }),
      policy,
    );
  }
}

/**
 * Slice 1: host AbortSignal ends with cancelled `done` + `post_turn`, not a bare throw.
 * Skip when a terminal `done` already reached the host stream.
 */
async function* emitCancelledDoneAfterAbort(ctx: TraceCtx): AsyncGenerator<TurnEvent> {
  if (ctx.seen.some((e) => e.type === 'done')) return;
  const stop = { kind: 'cancelled' as const };
  const done: TurnEvent = { type: 'done', stop, traceparent: ctx.root.traceparent() };
  const outDone = projectForObs(done, ctx.observability);
  yield deliver(ctx, outDone);

  const profile = getProfile(ctx.req.profile);
  const gen = ctx.generation;
  if (!(gen && ctx.safe && ctx.trace)) return;

  // The turn's own state when it got that far, so post_turn sees the history the model saw.
  const state =
    ctx.state ??
    openTurnState({
      profile,
      generation: gen,
      trace: ctx.trace,
      mediaFamily: ctx.mediaFamily,
      allEmittedEvents: [...ctx.seen],
    });
  for await (const stageEv of applyTurnStage({
    profile,
    generation: gen,
    state,
    stage: 'post_turn',
    step: Math.max(state.stepCount, 1),
    onStage: ctx.safe.onStage,
    stop,
    host: gen.host,
  })) {
    yield* emitObservedStage(ctx, stageEv, profile);
  }
}

async function* runTurnBody(ctx: TraceCtx, provider: ModelProvider): AsyncGenerator<TurnEvent> {
  const sanitized = sanitizeTurnRequestWithEvents(ctx.req);
  ctx.safe = sanitized.request;
  for (const event of sanitized.events) {
    if (event.guardrail) ctx.root.event('theorem.guardrail', guardrailAttributes(event.guardrail));
    yield deliver(ctx, projectForObs(event, ctx.observability));
  }
  const { profile, generation: gen } = resolveTurn(ctx.safe);
  await expandT1Policy(gen.tools, profile, ctx.safe);
  gen.builtins = gen.tools.builtins;
  ctx.generation = gen;
  ctx.canary = gen.canary;
  ctx.canaries.push(gen.canary);
  const binding = profile.models[gen.model];
  ctx.mediaFamily = binding ? mediaTokenFamily(binding) : undefined;
  ctx.trace = { root: ctx.root, attempt: 0, calls: 0, binding };

  throwIfAborted(ctx.safe.signal);

  const compactionSpec = ctx.compacting ? undefined : getCompactionSpec(profile, gen.model);
  await maybeCompactBefore(ctx, gen, compactionSpec, provider);

  ctx.system = bindCanary(
    gen.resolvedSystem,
    ctx.canary,
    resolveGuardrailPolicy(profile.guardrails).canaryBindNote,
  );

  yield* streamTurnEvents(ctx, profile, gen, provider, compactionSpec);
}

async function maybeCompactBefore(
  ctx: TraceCtx,
  gen: ResolvedGeneration,
  compactionSpec: CompactionSpec | undefined,
  provider: ModelProvider,
): Promise<void> {
  if (!(compactionSpec?.timing === 'before' && gen.history?.length && ctx.safe)) return;
  const before = gen.history;
  gen.history = await compactHistoryBeforeTurn({
    spec: compactionSpec,
    family: ctx.mediaFamily,
    history: gen.history,
    input: ctx.safe.input,
    provider,
    compactionProvider: ctx.req.compactionProvider,
    parent: ctx.root,
    canaries: ctx.canaries,
    signal: ctx.safe.signal,
  });
  ctx.compacted = gen.history !== before;
}

async function maybeAttachAfter(
  event: TurnEvent,
  ctx: TraceCtx,
  gen: ResolvedGeneration,
  compactionSpec: CompactionSpec | undefined,
): Promise<TurnEvent> {
  if (!(event.type === 'done' && compactionSpec?.timing === 'after' && ctx.safe)) {
    return event;
  }
  return await attachAfterCompaction(event, {
    spec: compactionSpec,
    family: ctx.mediaFamily,
    history: gen.history ?? [],
    input: ctx.safe.input,
    seen: ctx.seen,
    span: ctx.root,
  });
}

export { compactionTranscriptLine, runTurn };
