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
import { throwIfAborted } from '../../../guardrails/error.ts';
import { sanitizeTurnRequest } from '../../../guardrails/sanitize.ts';
import { noopSink, type TraceSink, writeTrace } from '../../../observability/trace.ts';
import { buildRecord } from '../../../observability/trace-record.ts';
import { pickSystemRole, resolveTurn } from '../../registry/resolve.ts';
import type { Protocol } from '../../schema.ts';
import { CONTINUE_INSTRUCTION } from '../../stop.ts';
import { cloneTurnToolSnapshot, expandT1Policy } from '../../tools/resolve.ts';
import type {
  CompactionSignal,
  CompactionSpec,
  ModelProvider,
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
} from '../../types.ts';
import { resolveCompactionTokens, shouldCompact, splitForCompaction } from '../compaction.ts';
import { runAttemptsWithValidation } from './gates.ts';
import type { StepExecutionState } from './state.ts';
import { shouldSkipStreamEvent, systemFromProfile } from './stream.ts';
import { calculateFallbackTokens } from './tokens.ts';

function getCompactionSpec(profile: Profile, modelId: string): CompactionSpec | undefined {
  return profile.models[modelId]?.compaction;
}

async function runCompactionTurn(
  toCompact: TurnHistoryMessage[],
  spec: CompactionSpec,
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<TurnHistoryMessage> {
  const compactText = toCompact
    .map((m) => {
      const content = m.content ?? m.parts?.map((p) => ('text' in p ? p.text : '')).join('') ?? '';
      return `[${m.role}]: ${content}`;
    })
    .join('\n');

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
}): AsyncGenerator<TurnEvent> {
  const { safe, profile, generation, system, provider, upstream } = args;

  const state: StepExecutionState = {
    currentHistory: [...(generation.history ?? [])],
    stepCount: 0,
    sawTokensEvent: false,
    allEmittedEvents: [],
    attemptEvents: [],
  };

  yield* runAttemptsWithValidation(safe, profile, generation, system, provider, upstream, state);

  if (!state.sawTokensEvent) {
    yield* calculateFallbackTokens(safe, system, state.allEmittedEvents);
  }

  yield {
    type: 'done',
    stop: state.lastStop ?? { kind: 'completed' },
    ...(state.lastStop?.kind === 'tool' && state.toolSnapshot
      ? { tools: cloneTurnToolSnapshot(state.toolSnapshot) }
      : {}),
  };
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
    }),
  );
}

/** Execute one host turn against a provider adapter. */
async function* runTurn(
  req: TurnRequest,
  provider: ModelProvider,
  sink: TraceSink = noopSink(),
): AsyncGenerator<TurnEvent> {
  const ctx: TraceCtx = {
    req,
    seen: [],
    started: Date.now(),
    canary: '',
    upstream: [],
  };
  try {
    yield* runTurnBody(ctx, provider);
  } catch (err) {
    await flushTurnTrace(sink, { ...ctx, thrown: err });
    throw err;
  }
  await flushTurnTrace(sink, ctx);
}

async function* runTurnBody(ctx: TraceCtx, provider: ModelProvider): AsyncGenerator<TurnEvent> {
  ctx.safe = sanitizeTurnRequest(ctx.req);
  throwIfAborted(ctx.safe.signal);
  const { profile, generation: gen } = resolveTurn(ctx.safe);
  await expandT1Policy(gen.tools, profile, ctx.safe);
  gen.builtins = gen.tools.builtins;
  ctx.generation = gen;
  ctx.model = gen.model;
  ctx.keySlot = gen.keySlot;
  ctx.canary = gen.canary;
  ctx.protocol = profile.models[gen.model]?.protocol;

  const isCompacting = ctx.req.metadata?._compacting === true;
  const compactionSpec = isCompacting ? undefined : getCompactionSpec(profile, gen.model);
  await maybeCompactBefore(ctx, gen, compactionSpec, provider);

  const role = pickSystemRole(profile, ctx.safe.input?.role);
  const continueSys = ctx.safe.continueFrom ? CONTINUE_INSTRUCTION : '';
  const combinedSys = [systemFromProfile(profile, role), ctx.safe.system, continueSys]
    .filter(Boolean)
    .join('\n\n');
  ctx.system = bindCanary(combinedSys, ctx.canary);

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

async function* streamTurnEvents(
  ctx: TraceCtx,
  profile: Profile,
  gen: ResolvedGeneration,
  provider: ModelProvider,
  compactionSpec: CompactionSpec | undefined,
  isCompacting: boolean,
): AsyncGenerator<TurnEvent> {
  if (!ctx.safe || ctx.system === undefined) return;
  for await (const event of emitTurn({
    safe: ctx.safe,
    profile,
    generation: gen,
    system: ctx.system,
    provider,
    upstream: ctx.upstream,
  })) {
    const out = await maybeAttachAfter(event, ctx, gen, compactionSpec, isCompacting);
    ctx.seen.push(out);
    if (!shouldSkipStreamEvent(out, profile)) yield out;
  }
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

export { runTurn };
