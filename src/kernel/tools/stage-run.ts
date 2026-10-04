import type { z } from 'zod';
import { type LexiconOverrides, lexiconText } from '../../guardrails/lexicon.ts';
import type { SpanHandle } from '../../observability/trace-span.ts';
import {
  type InjectUnit,
  runStage,
  type StageHandler,
  type StageResult,
  stageEventFields,
} from '../stages.ts';
import type { Profile, TurnEvent, TurnHistoryMessage } from '../types.ts';
import { type ToolCallBase, toolEvent } from './events.ts';
import { isGateResumeGranted } from './permission.ts';
import { plainToolInput } from './schema.ts';
import type { ModelToolResult, ToolContext, ToolFailure, ToolGate } from './types.ts';

export interface ToolStageSupport {
  /** In order: request `onStage`, then turn/session ambient. */
  handlers: StageHandler[];
  /** Its guardrails sanitize injects and its inject gate applies. */
  profile: Profile;
  step: number;
  history: () => readonly TurnHistoryMessage[];
  injectAllowed: boolean;
  injectWouldExceedMaxSteps?: boolean;
  host?: unknown;
  signal?: AbortSignal;
  span?: SpanHandle;
}

function defaultToolStageSupport(ctx: ToolContext): ToolStageSupport {
  return {
    handlers: [],
    profile: ctx.profile,
    step: ctx.turn?.step ?? 1,
    history: () => [],
    injectAllowed: false,
    host: ctx.host,
    signal: ctx.signal,
  };
}

export type PreBodyOutcome =
  | { ok: true; input: unknown }
  | { ok: false; kind: 'aborted'; aborted: true | { reason?: string } }
  | { ok: false; kind: 'gated'; gate: ToolGate }
  | {
      ok: false;
      kind: 'failed';
      failure: ToolFailure;
      /** The host refused the call (`deny`), rather than it failing. */
      denied?: true;
    };

export type PostToolStageOutcome = {
  abort?: boolean | { reason?: string };
  /** The caller lands these after recording the tool result. */
  inject: InjectUnit[];
  deny?: { code: string; message: string };
  /** The caller re-validates and re-projects it. */
  mutate?: { output: unknown };
};

/** Tool `preTool` → host `pre_tool` → mutate re-parse. */
export async function* runPreToolPipeline(args: {
  tool: {
    name: string;
    input: { safeParse: (value: unknown) => z.ZodSafeParseResult<unknown> };
    preTool?: (
      input: never,
      ctx: ToolContext,
    ) => StageResult | undefined | Promise<StageResult | undefined>;
  };
  input: unknown;
  ctx: ToolContext;
  base: ToolCallBase;
  stages?: ToolStageSupport;
}): AsyncGenerator<TurnEvent, PreBodyOutcome> {
  const { tool, ctx, base, stages } = args;
  let toolPreTool: StageResult | undefined;
  // An approval skips the tool's own check it already passed — unless the user edited the arguments.
  const approvedAsIs = isGateResumeGranted(ctx.resume) && ctx.resume?.edited === undefined;
  if (tool.preTool && !approvedAsIs) {
    toolPreTool = (await tool.preTool(args.input as never, ctx)) ?? undefined;
  }
  if (!stages && toolPreTool === undefined) {
    return { ok: true, input: args.input };
  }
  const pre = yield* runPreToolStages({
    stages: stages ?? defaultToolStageSupport(ctx),
    toolName: tool.name,
    callId: base.callId,
    input: args.input,
    toolPreTool,
  });
  if (!pre.ok) {
    if (pre.kind === 'gated') yield toolEvent(base, { phase: 'gate', gate: pre.gate });
    return pre;
  }
  if (!pre.mutated) return { ok: true, input: pre.input };
  const reparsed = tool.input.safeParse(plainToolInput(pre.input));
  if (!reparsed.success) {
    return {
      ok: false,
      kind: 'failed',
      failure: {
        code: 'invalid_input',
        kind: 'bad_response',
        message: lexiconText('tool.input_invalid_after_mutate', {}, args.ctx.profile.lexicon),
        details: reparsed.error.flatten(),
      },
    };
  }
  return { ok: true, input: reparsed.data };
}

async function* runPreToolStages(args: {
  stages: ToolStageSupport;
  toolName: string;
  callId: string;
  input: unknown;
  toolPreTool?: StageResult | undefined;
}): AsyncGenerator<
  TurnEvent,
  Exclude<PreBodyOutcome, { ok: true }> | { ok: true; input: unknown; mutated: boolean }
> {
  const { stages, toolName, callId, input, toolPreTool } = args;
  const applied = yield* runStage({
    stage: 'pre_tool',
    step: stages.step,
    history: stages.history(),
    handlers: [...(toolPreTool !== undefined ? [() => toolPreTool] : []), ...stages.handlers],
    guardrails: stages.profile.guardrails,
    injectAllowed: false,
    host: stages.host,
    signal: stages.signal,
    span: stages.span,
    callId,
    tool: toolName,
    input,
  });

  if (applied.abort) {
    return { ok: false, kind: 'aborted', aborted: applied.abort };
  }
  if (applied.deny) {
    return {
      ok: false,
      kind: 'failed',
      failure: { ...applied.deny, kind: 'blocked' },
      denied: true,
    };
  }
  if (applied.confirm) {
    const gate: ToolGate = {
      kind: 'confirmation',
      tool: toolName,
      ...(applied.confirm.summary ? { summary: applied.confirm.summary } : {}),
    };
    yield stageEventFields('pre_tool', { callId, toolName, callNotStarted: true, gate });
    return { ok: false, kind: 'gated', gate };
  }
  if (applied.mutate && 'input' in applied.mutate) {
    return { ok: true, input: applied.mutate.input, mutated: true };
  }
  return { ok: true, input, mutated: false };
}

export async function* runPostToolStages(args: {
  stages: ToolStageSupport;
  toolName: string;
  callId: string;
  input?: unknown;
  callNotStarted?: boolean;
  outputRaw?: unknown;
  outputModel?: ModelToolResult;
  failure?: ToolFailure;
  awaiting?: boolean;
  /** False when there is no completed output for `mutate` to replace. */
  mutable: boolean;
}): AsyncGenerator<TurnEvent, PostToolStageOutcome> {
  const { stages, toolName, callId, mutable, ...call } = args;
  const applied = yield* runStage({
    ...call,
    stage: 'post_tool',
    step: stages.step,
    history: stages.history(),
    handlers: stages.handlers,
    guardrails: stages.profile.guardrails,
    injectAllowed: stages.injectAllowed,
    injectWouldExceedMaxSteps: stages.injectWouldExceedMaxSteps,
    mutable,
    host: stages.host,
    signal: stages.signal,
    span: stages.span,
    callId,
    tool: toolName,
  });

  return {
    ...(applied.abort !== undefined ? { abort: applied.abort } : {}),
    ...(applied.deny ? { deny: applied.deny } : {}),
    ...(applied.mutate && 'output' in applied.mutate ? { mutate: applied.mutate } : {}),
    inject: applied.inject,
  };
}

/**
 * Returns the sign-in gate's `readBack`: what a transport that answers the call now (Live) tells
 * the model while the person signs in. Other gates hold the call, and the model reads nothing yet.
 */
export async function* emitGateSettlement(args: {
  base: ToolCallBase;
  gate: ToolGate;
  callId: string;
  toolName: string;
  lexicon: LexiconOverrides | undefined;
}): AsyncGenerator<TurnEvent, string | undefined> {
  yield stageEventFields('pre_tool', {
    callId: args.callId,
    toolName: args.toolName,
    callNotStarted: true,
    gate: args.gate,
  });
  const readBack =
    args.gate.kind === 'auth'
      ? lexiconText('sign_in.pending', { service: args.gate.authChallenge.service }, args.lexicon)
      : undefined;
  yield toolEvent(args.base, { phase: 'gate', gate: args.gate, ...(readBack ? { readBack } : {}) });
  return readBack;
}
