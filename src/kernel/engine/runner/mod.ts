import { bindCanary, bindUserDataNote } from '../../../guardrails/canary.ts';
import type { ErrorKind } from '../../../guardrails/error.ts';
import {
  isAbortError,
  TheoremError,
  throwIfAborted,
  withPublicWording,
} from '../../../guardrails/error.ts';
import { projectGuardrailTurnEvent } from '../../../guardrails/events.ts';
import { lexiconText } from '../../../guardrails/lexicon.ts';
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
import { profileTypesForField } from '../../profile-scope.ts';
import { requireModelBinding } from '../../registry/catalog.ts';
import type { KernelRegistry } from '../../registry/kernel-registry.ts';
import { resolveTurnInRegistry } from '../../registry/resolve.ts';
import { cloneTurnToolSnapshot, expandT1Policy } from '../../tools/resolve.ts';
import { turnDoneOf } from '../../turn-events.ts';
import type {
  CompactHistoryRequest,
  CompactionResult,
  CompactionSignal,
  CompactionSpec,
  ModelId,
  ModelProfile,
  ModelProvider,
  Profile,
  ProfileId,
  ResolvedGeneration,
  TurnEvent,
  TurnEventOf,
  TurnHistoryMessage,
  TurnRequest,
  TurnTokens,
  TurnToolSnapshot,
} from '../../types.ts';
import { findLast } from '../../util/find-last.ts';
import {
  type CompactionTokens,
  type CompactorRun,
  compactionMeter,
  compactionResult,
  compactorHistory,
  resolveCompactionTokens,
  shouldCompact,
  splitForCompaction,
} from '../compaction.ts';
import { type MediaTokenFamily, mediaTokenFamily } from '../token-estimate.ts';
import {
  endThrownSpan,
  endTurnSpan,
  guardrailAttributes,
  guardrailCheckAttributes,
  OutputFold,
  turnSpanOptions,
} from '../turn-trace.ts';
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

const MS_PER_S = 1000;

/**
 * Record an event as delivered to the host; every yield to the host passes
 * through here, so it is where an error gets the user's wording.
 */
function deliver(ctx: TraceCtx, event: TurnEvent): TurnEvent {
  const out = withPublicWording(event, ctx.known?.lexicon);
  if (out.type === 'text' && !ctx.shownText) {
    ctx.shownText = true;
    ctx.root.set({ 'theorem.turn.time_to_first_text': ctx.root.msSinceStart() / MS_PER_S });
  }
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

/** Errors only the host can fix: the compactor throws them rather than failing quietly every turn. */
/** A turn's tools when it offers none: an agent summarising its own history. */
function noTools(): TurnToolSnapshot {
  return { builtins: [], gated: [], visible: [], executable: [], wire: [] };
}

const COMPACTOR_THROWS: ReadonlySet<ErrorKind> = new Set(['config', 'request', 'auth', 'internal']);

function turnError(events: readonly TurnEvent[]): TurnEventOf<'error'> | undefined {
  return events.find((e): e is TurnEventOf<'error'> => e.type === 'error');
}

/**
 * Run the compaction profile as a turn under `span`: its spans join that
 * record and it writes none of its own. Anything short of a completed,
 * non-empty summary is a failure; the host's abort and `COMPACTOR_THROWS`
 * errors are thrown. With no `spec.profile` the owner compacts itself, on the
 * model it is compacting for and with no tools.
 */
async function runCompactor(args: {
  registry: KernelRegistry;
  owner: ProfileId;
  model: ModelId;
  toCompact: TurnHistoryMessage[];
  spec: CompactionSpec;
  provider: ModelProvider;
  parent: SpanHandle;
  canaries: string[];
  signal?: AbortSignal;
}): Promise<CompactorRun> {
  const self = args.spec.profile === undefined;
  const compactorId = args.spec.profile ?? args.owner;
  const compactor = args.registry.profiles.get(compactorId) as ModelProfile;
  const { history, droppedMedia } = compactorHistory(args.toCompact, compactor);
  if (history.length === 0) return { droppedMedia, failure: { unreadable: true } };
  const req: TurnRequest = {
    profile: compactorId,
    // The turn already passed model selection; its default needs no naming.
    ...(self && args.model !== compactor.defaultModel ? { model: args.model } : {}),
    input: { text: lexiconText('compaction.request', {}, compactor.lexicon), history },
    signal: args.signal,
  };
  const ctx = newTraceCtx(
    args.registry,
    req,
    args.parent.child(`invoke_agent ${req.profile}`, turnSpanOptions(req)),
    args.canaries,
  );
  ctx.compacting = self ? 'self' : 'other';
  ctx.observability = resolveObservabilityPolicy(ctx.known?.observability);

  const events: TurnEvent[] = [];
  try {
    for await (const event of runTracedTurn(ctx, args.provider)) {
      events.push(event);
    }
  } catch (err) {
    throwIfAborted(args.signal);
    const error = err instanceof TheoremError ? err.kind : 'internal';
    if (COMPACTOR_THROWS.has(error)) throw err;
    return { droppedMedia, failure: { error } };
  }
  throwIfAborted(args.signal);

  const tokens = sumEventTokens(events);
  const usage = tokens ? { tokens } : {};
  const stop = findLast(events, (e): e is TurnEventOf<'done'> => e.type === 'done')?.stop.kind;
  const reported = turnError(events);
  if (reported && COMPACTOR_THROWS.has(reported.errorKind)) {
    throw new TheoremError(
      reported.errorKind,
      `Compactor '${compactorId}' failed: ${reported.errorInternal ?? reported.error}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const error = reported?.errorKind;
  if (stop !== 'completed' || error) {
    return {
      droppedMedia,
      failure: { ...(stop ? { stop } : {}), ...(error ? { error } : {}) },
      ...usage,
    };
  }
  const structured = findLast(
    events,
    (e): e is TurnEventOf<'structured'> => e.type === 'structured',
  )?.structured;
  const summary =
    structured === undefined
      ? events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')
      : JSON.stringify(structured);
  if (!summary.trim()) {
    return { droppedMedia, failure: { stop, empty: true }, ...usage };
  }
  return { summary, droppedMedia, ...usage };
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

/** A compaction that ran, as `theorem.compaction` attributes beside its decision. */
function compactionOutcome(
  result: Omit<CompactionResult, 'toCompact'>,
  messagesBefore: number,
): TraceAttributes {
  return {
    outcome: result.outcome,
    messages_before: messagesBefore,
    messages_after: result.history.length,
    dropped_media: result.droppedMedia,
    ...(result.failure?.stop ? { failure_stop: result.failure.stop } : {}),
    ...(result.failure?.error ? { failure_error: result.failure.error } : {}),
    ...(result.failure?.empty ? { failure_empty: true } : {}),
    ...(result.failure?.unreadable ? { failure_unreadable: true } : {}),
    ...(result.summary === undefined ? {} : { summary: traceContent(result.summary) }),
  };
}

async function compactHistoryBeforeTurn(args: {
  registry: KernelRegistry;
  owner: ProfileId;
  model: ModelId;
  spec: CompactionSpec;
  family: MediaTokenFamily | undefined;
  history: TurnHistoryMessage[];
  input: TurnRequest['input'];
  provider: ModelProvider;
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
  const split = await splitForCompaction(args.history, args.spec, args.family);
  if (split.toCompact.length === 0) {
    args.parent.event('theorem.compaction', attributes);
    return undefined;
  }
  const run = await runCompactor({ ...args, toCompact: split.toCompact });
  const { toCompact: _compacted, ...result } = compactionResult(
    split,
    run,
    decision.tokens,
    args.spec,
  );
  args.parent.event('theorem.compaction', {
    ...attributes,
    ...compactionOutcome(result, args.history.length),
  });
  return {
    type: 'compaction',
    timing: 'before',
    meter: decision.meter,
    tokensBefore: decision.tokens,
    unknownMedia: decision.unknownMedia,
    messagesBefore: args.history.length,
    messagesAfter: result.history.length,
    ...result,
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
  /** Set once the host has been given reply text. */
  shownText?: boolean;
  delivered: OutputFold;
  root: SpanHandle;
  /** Step-state trace handle, once the turn's model binding is known. */
  trace?: TurnTraceState;
  /**
   * Set on the compaction profile's own nested turn, which never compacts:
   * `self` when the agent summarises its own history, and then offers no tools.
   */
  compacting: false | 'self' | 'other';
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
  const checkStart = performance.now();
  const sanitized = sanitizeTurnRequestWithEvents(
    ctx.req,
    ctx.registry.profiles.get(ctx.req.profile),
  );
  const checkMs = performance.now() - checkStart;
  ctx.safe = sanitized.request;
  const hits = sanitized.events.filter((event) => event.type === 'guardrail');
  // The check's time rides on its last decision, or on a pass when it found nothing.
  if (hits.length === 0) {
    ctx.root.event(
      'theorem.guardrail',
      guardrailCheckAttributes('input', checkMs, undefined, { stage: 'input', trust: 'untrusted' }),
    );
  }
  for (const event of sanitized.events) {
    if (event.type === 'guardrail') {
      ctx.root.event(
        'theorem.guardrail',
        event === hits.at(-1)
          ? guardrailCheckAttributes('input', checkMs, event.guardrail, event.guardrail)
          : guardrailAttributes(event.guardrail),
      );
    }
    yield deliver(ctx, projectForObs(event, ctx.observability));
  }
  const { profile, generation: gen } = resolveTurnInRegistry(ctx.registry, ctx.safe);
  await expandT1Policy(ctx.registry.tools, gen.tools, profile, ctx.safe);
  if (ctx.compacting === 'self') gen.tools = noTools();
  gen.builtins = gen.tools.builtins;
  ctx.generation = gen;
  ctx.canary = gen.canary;
  ctx.canaries.push(gen.canary);
  const binding = profile.models[gen.model];
  ctx.mediaFamily = binding ? mediaTokenFamily(binding) : undefined;
  ctx.trace = { root: ctx.root, attempt: 0, calls: 0, binding };

  throwIfAborted(ctx.safe.signal);

  const compactionSpec = ctx.compacting ? undefined : getCompactionSpec(profile, gen.model);
  const compaction = await maybeCompactBefore(ctx, profile, gen, compactionSpec, provider);
  if (compaction) yield deliver(ctx, projectForObs(compaction, ctx.observability));

  const system = bindCanary(gen.resolvedSystem, ctx.canary, profile.lexicon);
  ctx.system = profileTypesForField('identity.system').includes(profile.type)
    ? bindUserDataNote(system, profile.lexicon)
    : system;

  yield* streamTurnEvents(ctx, profile, gen, provider, compactionSpec);
}

/**
 * The turn's provider runs the compactor only when it is the one the compactor
 * would get: a text profile on the same protocol and provider.
 */
function compactorProvider(
  ctx: TraceCtx,
  profile: ModelProfile,
  spec: CompactionSpec,
  provider: ModelProvider,
): ModelProvider {
  if (ctx.req.compactionProvider) return ctx.req.compactionProvider;
  if (spec.profile === undefined) return provider;
  const compactor = ctx.registry.profiles.get(spec.profile) as ModelProfile;
  const own = ctx.trace?.binding;
  const theirs = compactor.models[compactor.defaultModel];
  if (
    profile.type !== 'text' ||
    own?.provider !== theirs?.provider ||
    own?.protocol !== theirs?.protocol
  ) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} compacts with '${spec.profile}', which this turn's provider cannot run; pass compactionProvider`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  return provider;
}

async function maybeCompactBefore(
  ctx: TraceCtx,
  profile: ModelProfile,
  gen: ResolvedGeneration,
  compactionSpec: CompactionSpec | undefined,
  provider: ModelProvider,
): Promise<TurnEventOf<'compaction'> | undefined> {
  if (!(compactionSpec?.timing === 'before' && ctx.safe)) return undefined;
  const compactor = compactorProvider(ctx, profile, compactionSpec, provider);
  if (!gen.history?.length) return undefined;
  const compaction = await compactHistoryBeforeTurn({
    registry: ctx.registry,
    owner: profile.id,
    model: gen.model,
    spec: compactionSpec,
    family: ctx.mediaFamily,
    history: gen.history,
    input: ctx.safe.input,
    provider: compactor,
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

/**
 * `timing: 'after'`: run the compactor on the history `done.compaction` carried,
 * with the same split, failure rules and trace as `before`. `provider` runs the
 * compactor. `undefined` when the split leaves nothing to compact.
 */
async function compactHistoryInRegistry(
  registry: KernelRegistry,
  req: CompactHistoryRequest,
  provider: ModelProvider,
  sinkOverride?: TraceSink,
): Promise<CompactionResult | undefined> {
  const profile = registry.profiles.get(req.profile) as ModelProfile;
  const model = req.model ?? profile.defaultModel;
  const binding = requireModelBinding(profile, model);
  const spec = binding.compaction;
  if (!spec) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} model '${model}' has no compaction`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const family = mediaTokenFamily(binding);
  const split = await splitForCompaction(req.history, spec, family);
  if (split.toCompact.length === 0) return undefined;

  const turnReq: TurnRequest = {
    profile: req.profile,
    input: {},
    ...(req.conversationId ? { conversationId: req.conversationId } : {}),
  };
  const tree = startTrace(`invoke_agent ${req.profile}`, {
    ...turnSpanOptions(turnReq),
    ...(req.traceparent ? { traceparent: req.traceparent } : {}),
  });
  const { sink, policy } = resolveTraceWriter({
    override: sinkOverride,
    observability: profile.observability,
  });
  const canaries: string[] = [];
  try {
    const run = await runCompactor({
      registry,
      owner: profile.id,
      model,
      toCompact: split.toCompact,
      spec,
      provider,
      parent: tree.root,
      canaries,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    const result = compactionResult(split, run, req.tokens, spec);
    tree.root.event('theorem.compaction', {
      timing: spec.timing,
      meter: compactionMeter(spec),
      budget: spec.maxTokens,
      threshold: spec.compactAt,
      tokens_before: req.tokens,
      ...compactionOutcome(result, req.history.length),
    });
    tree.root.end();
    return result;
  } catch (err) {
    endThrownSpan(tree.root, err);
    throw err;
  } finally {
    await writeTrace(
      sink,
      buildRecord({
        spans: tree.collect(),
        policy,
        canaries,
        ...(req.metadata ? { metadata: req.metadata } : {}),
      }),
      policy,
    );
  }
}

export { compactHistoryInRegistry, runTurnInRegistry };
