import { bindCanary } from '../../../guardrails/canary.ts';
import { isAbortError, throwIfAborted, withPublicWording } from '../../../guardrails/error.ts';
import { projectGuardrailTurnEvent } from '../../../guardrails/events.ts';
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
import type { KernelRegistry } from '../../registry/kernel-registry.ts';
import { resolveTurnInRegistry } from '../../registry/resolve.ts';
import { cloneTurnToolSnapshot, expandT1Policy } from '../../tools/resolve.ts';
import { turnDoneOf } from '../../turn-events.ts';
import type {
  CompactionSignal,
  CompactionSpec,
  ModelProfile,
  ModelProvider,
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnEventOf,
  TurnHistoryMessage,
  TurnRequest,
  TurnTokens,
} from '../../types.ts';
import { findLast } from '../../util/find-last.ts';
import {
  type CompactionTokens,
  compactionMeter,
  resolveCompactionTokens,
  shouldCompact,
  splitForCompaction,
} from '../compaction.ts';
import { type MediaTokenFamily, mediaTokenFamily } from '../token-estimate.ts';
import { endTurnSpan, guardrailAttributes, OutputFold, turnSpanOptions } from '../turn-trace.ts';
import { sumEventTokens } from '../usage.ts';
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

/**
 * Record an event as delivered to the host; every yield to the host passes
 * through here, so it is where an error gets the user's wording.
 */
function deliver(ctx: TraceCtx, event: TurnEvent): TurnEvent {
  const out = withPublicWording(event, ctx.known?.lexicon);
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
  registry: KernelRegistry,
  toCompact: TurnHistoryMessage[],
  spec: CompactionSpec,
  provider: ModelProvider,
  parent: SpanHandle,
  canaries: string[],
  signal?: AbortSignal,
): Promise<{ summary: TurnHistoryMessage; tokens?: TurnTokens }> {
  const compactText = toCompact.map(compactionTranscriptLine).join('\n');
  const req: TurnRequest = { profile: spec.profile, input: { text: compactText }, signal };
  const ctx = newTraceCtx(
    registry,
    req,
    parent.child(`invoke_agent ${req.profile}`, turnSpanOptions(req)),
    canaries,
  );
  ctx.compacting = true;
  ctx.observability = resolveObservabilityPolicy(ctx.known?.observability);

  const events: TurnEvent[] = [];
  for await (const event of runTracedTurn(ctx, provider)) {
    events.push(event);
  }

  const structured = findLast(
    events,
    (e): e is TurnEventOf<'structured'> => e.type === 'structured',
  )?.structured;
  const text = structured
    ? JSON.stringify(structured)
    : events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
  const tokens = sumEventTokens(events);

  return {
    summary: { role: 'assistant', content: text, metadata: { compactionSummary: true } },
    ...(tokens ? { tokens } : {}),
  };
}

function lastTokensFromEvents(events: TurnEvent[]): TurnTokens | undefined {
  return findLast(events, (e): e is TurnEventOf<'tokens'> => e.type === 'tokens')?.tokens;
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
  registry: KernelRegistry;
  spec: CompactionSpec;
  family: MediaTokenFamily | undefined;
  history: TurnHistoryMessage[];
  input: TurnRequest['input'];
  provider: ModelProvider;
  compactionProvider?: ModelProvider;
  parent: SpanHandle;
  canaries: string[];
  signal?: AbortSignal;
}): Promise<TurnEventOf<'compaction'> | undefined> {
  const decision = await resolveCompactionTokens({
    spec: args.spec,
    input: args.input,
    family: args.family,
  });
  const needed = decision !== undefined && (await shouldCompact(decision, args.spec));
  const attributes = compactionDecision(args.spec, decision, needed);
  if (!(needed && decision)) {
    args.parent.event('theorem.compaction', attributes);
    return undefined;
  }
  const { toCompact, toRetain } = await splitForCompaction(args.history, args.spec, args.family);
  if (toCompact.length === 0) {
    args.parent.event('theorem.compaction', { ...attributes, compacted: false });
    return undefined;
  }
  const { summary, tokens } = await runCompactionTurn(
    args.registry,
    toCompact,
    args.spec,
    args.compactionProvider ?? args.provider,
    args.parent,
    args.canaries,
    args.signal,
  );
  const history = [summary, ...toRetain];
  const summaryText = summary.content ?? '';
  args.parent.event('theorem.compaction', {
    ...attributes,
    compacted: true,
    messages_before: args.history.length,
    messages_after: history.length,
    summary: traceContent(summaryText),
  });
  return {
    type: 'compaction',
    timing: 'before',
    meter: decision.meter,
    tokensBefore: decision.tokens,
    unknownMedia: decision.unknownMedia,
    messagesBefore: args.history.length,
    messagesAfter: history.length,
    summary: summaryText,
    history,
    ...(tokens ? { tokens } : {}),
  };
}

async function attachAfterCompaction(
  event: TurnEventOf<'done'>,
  args: {
    spec: CompactionSpec;
    family: MediaTokenFamily | undefined;
    history: TurnHistoryMessage[];
    input: TurnRequest['input'];
    seen: TurnEvent[];
    span: SpanHandle;
  },
): Promise<TurnEventOf<'done'>> {
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
  registry: KernelRegistry;
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
    tools: args.registry.tools,
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

  const tokens = sumEventTokens(state.allEmittedEvents);
  const done = turnDoneOf(
    {
      stop: state.lastStop ?? { kind: 'completed' },
      traceparent: state.trace.root.traceparent(),
      ...(tokens ? { tokens } : {}),
    },
    cloneTurnToolSnapshot(generation.tools),
  );
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
    registry: ctx.registry,
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
  /** The scope the turn runs in; its nested compaction turn runs there too. */
  registry: KernelRegistry;
  req: TurnRequest;
  /**
   * The request's profile when the scope has it. An unknown profile fails in
   * `resolveTurnInRegistry`; until then its wording and observability are the standard ones.
   */
  known: Profile | undefined;
  seen: TurnEvent[];
  delivered: OutputFold;
  root: SpanHandle;
  /** Step-state trace handle, once the turn's model binding is known. */
  trace?: TurnTraceState;
  /** True for the compaction profile's own nested turn, which never compacts. */
  compacting: boolean;
  canary: string;
  /** Every canary bound in this record; a nested turn shares its parent's list. */
  canaries: string[];
  system?: string;
  generation?: ResolvedGeneration;
  mediaFamily?: MediaTokenFamily;
  safe?: TurnRequest;
  observability?: ResolvedObservabilityPolicy;
  state?: StepExecutionState;
};

function newTraceCtx(
  registry: KernelRegistry,
  req: TurnRequest,
  root: SpanHandle,
  canaries: string[],
): TraceCtx {
  return {
    registry,
    req,
    known: registry.profiles.find(req.profile),
    seen: [],
    delivered: new OutputFold(),
    root,
    compacting: false,
    canary: '',
    canaries,
  };
}

function endTurn(ctx: TraceCtx, thrown?: unknown): void {
  const calls = ctx.trace?.calls ?? 0;
  endTurnSpan(ctx.root, {
    seen: ctx.seen,
    delivered: ctx.delivered,
    attempts: calls > 0 ? (ctx.trace?.attempt ?? 0) + 1 : 0,
    calls,
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
 * The trace record is written however the turn ends, including when the host stops reading early;
 * spans still open then close as `ERROR` / `unclosed`.
 */
async function* runTurnInRegistry(
  registry: KernelRegistry,
  req: TurnRequest,
  provider: ModelProvider,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  const tree = startTrace(`invoke_agent ${req.profile}`, {
    ...turnSpanOptions(req),
    ...(req.traceparent ? { traceparent: req.traceparent } : {}),
  });
  const ctx = newTraceCtx(registry, req, tree.root, []);
  const { sink, policy } = resolveTraceWriter({
    override: sinkOverride,
    observability: ctx.known?.observability,
  });
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

/** A host abort ends with a cancelled `done` + `post_turn`, not a bare throw. */
async function* emitCancelledDoneAfterAbort(ctx: TraceCtx): AsyncGenerator<TurnEvent> {
  if (ctx.seen.some((e) => e.type === 'done')) return;
  const stop = { kind: 'cancelled' as const };
  const done: TurnEvent = { type: 'done', stop, traceparent: ctx.root.traceparent() };
  const outDone = projectForObs(done, ctx.observability);
  yield deliver(ctx, outDone);

  const profile = ctx.known;
  const gen = ctx.generation;
  if (!(profile && gen && ctx.safe && ctx.trace)) return;

  // The turn's own state when it got that far, so post_turn sees the history the model saw.
  const state =
    ctx.state ??
    openTurnState({
      tools: ctx.registry.tools,
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
  const sanitized = sanitizeTurnRequestWithEvents(
    ctx.req,
    ctx.registry.profiles.get(ctx.req.profile),
  );
  ctx.safe = sanitized.request;
  for (const event of sanitized.events) {
    if (event.type === 'guardrail') {
      ctx.root.event('theorem.guardrail', guardrailAttributes(event.guardrail));
    }
    yield deliver(ctx, projectForObs(event, ctx.observability));
  }
  const { profile, generation: gen } = resolveTurnInRegistry(ctx.registry, ctx.safe);
  await expandT1Policy(ctx.registry.tools, gen.tools, profile, ctx.safe);
  gen.builtins = gen.tools.builtins;
  ctx.generation = gen;
  ctx.canary = gen.canary;
  ctx.canaries.push(gen.canary);
  const binding = profile.models[gen.model];
  ctx.mediaFamily = binding ? mediaTokenFamily(binding) : undefined;
  ctx.trace = { root: ctx.root, attempt: 0, calls: 0, binding };

  throwIfAborted(ctx.safe.signal);

  const compactionSpec = ctx.compacting ? undefined : getCompactionSpec(profile, gen.model);
  const compaction = await maybeCompactBefore(ctx, gen, compactionSpec, provider);
  if (compaction) yield deliver(ctx, projectForObs(compaction, ctx.observability));

  ctx.system = bindCanary(gen.resolvedSystem, ctx.canary, profile.lexicon);

  yield* streamTurnEvents(ctx, profile, gen, provider, compactionSpec);
}

async function maybeCompactBefore(
  ctx: TraceCtx,
  gen: ResolvedGeneration,
  compactionSpec: CompactionSpec | undefined,
  provider: ModelProvider,
): Promise<TurnEventOf<'compaction'> | undefined> {
  if (!(compactionSpec?.timing === 'before' && gen.history?.length && ctx.safe)) return undefined;
  const compaction = await compactHistoryBeforeTurn({
    registry: ctx.registry,
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
  if (compaction) gen.history = compaction.history;
  return compaction;
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

export { compactionTranscriptLine, runTurnInRegistry };
