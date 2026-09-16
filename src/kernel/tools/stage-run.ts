/**
 * Tool execute wiring around the stage spine: `pre_tool` outcomes (deny, gate,
 * mutate, abort) and `post_tool` inject hand-off.
 *
 * Contract: `docs/contracts/stages.md` (tool execute pipeline).
 *
 * @module
 */

import type { z } from 'zod';
import { lexiconText } from '../../guardrails/lexicon.ts';
import { runStage, type StageHandler, type StageResult, stageEventFields } from '../stages.ts';
import type { Profile, TurnEvent, TurnHistoryMessage } from '../types.ts';
import type { ToolCallBase } from './events.ts';
import { isGateResumeGranted } from './permission.ts';
import { plainToolInput } from './schema.ts';
import type { ModelToolResult, ToolContext, ToolFailure, ToolGate } from './types.ts';

/** Stage wiring passed into `executeRegisteredTool`. */
export interface ToolStageSupport {
  /** Ordered host handlers: request `onStage`, then turn/session ambient. */
  handlers: StageHandler[];
  /** Profile whose guardrails sanitize injects and whose inject gate applies. */
  profile: Profile;
  step: number;
  history: () => readonly TurnHistoryMessage[];
  injectAllowed: boolean;
  injectWouldExceedMaxSteps?: boolean;
  /** Apply sanitized inject messages immediately instead of handing them back. */
  applyInject?: (messages: TurnHistoryMessage[]) => void;
  host?: unknown;
  signal?: AbortSignal;
}

/** Stage support when only a tool-local `preTool` is present. */
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

/**
 * Everything before a tool body runs, after schema + permission: tool `preTool`,
 * host `pre_tool`, and the mutate re-parse. Each execute path maps the terminal
 * shapes onto its own settlement; the pipeline itself lives here once.
 */
export type PreBodyOutcome =
  | { ok: true; input: unknown }
  | { ok: false; kind: 'aborted'; aborted: true | { reason?: string } }
  | { ok: false; kind: 'gated'; gate: ToolGate }
  | { ok: false; kind: 'failed'; failure: ToolFailure };

export type PostToolStageOutcome = {
  abort?: boolean | { reason?: string };
  /** Sanitized inject messages for the caller to apply after recording the tool result. */
  inject?: TurnHistoryMessage[];
  /** Host refused the result: the model gets this failure instead. */
  deny?: { code: string; message: string };
  /** Host replaced the raw output; the caller re-validates and re-projects it. */
  mutate?: { output: unknown };
};

/**
 * Tool-local `preTool` (skipped when resume.granted) → host `pre_tool` →
 * mutate re-parse. Emits the gate wire for a host confirm.
 */
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
  if (tool.preTool && !isGateResumeGranted(ctx.resume)) {
    toolPreTool = (await tool.preTool(args.input as never, ctx)) ?? undefined;
  }
  if (!stages && toolPreTool === undefined) {
    return { ok: true, input: args.input };
  }
  const pre = yield* runPreToolStages({
    stages: stages ?? defaultToolStageSupport(ctx),
    toolName: tool.name,
    callId: base.callId ?? '',
    input: args.input,
    toolPreTool,
  });
  if (!pre.ok) {
    if (pre.kind === 'gated') yield gateEvent(base, pre.gate);
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
        message: lexiconText('tool.input_invalid_after_mutate'),
        details: reparsed.error.flatten(),
      },
    };
  }
  return { ok: true, input: reparsed.data };
}

/** Emit `pre_tool`, run tool `preTool` then host handlers, map affordances to an outcome. */
async function* runPreToolStages(args: {
  stages: ToolStageSupport;
  toolName: string;
  callId: string;
  input: unknown;
  /** Tool-local `preTool` return (already awaited by caller if needed). */
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
    callId,
    tool: toolName,
    input,
  });

  if (applied.abort) {
    return { ok: false, kind: 'aborted', aborted: applied.abort };
  }
  if (applied.deny) {
    return { ok: false, kind: 'failed', failure: applied.deny };
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

/** Emit `post_tool`, run host handlers, hand back inject/abort. */
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
    callId,
    tool: toolName,
  });

  const terminal: Omit<PostToolStageOutcome, 'inject'> = {
    ...(applied.abort !== undefined ? { abort: applied.abort } : {}),
    ...(applied.deny ? { deny: applied.deny } : {}),
    ...(applied.mutate && 'output' in applied.mutate ? { mutate: applied.mutate } : {}),
  };
  if (applied.inject.length === 0) return terminal;
  // Prefer returning inject for the runner to apply after recording the provider
  // tool result (Interactions continuation must exist first). When applyInject is
  // set the caller wants immediate apply (e.g. invokeTool).
  if (stages.applyInject) {
    stages.applyInject(applied.inject);
    return terminal;
  }
  return { ...terminal, inject: applied.inject };
}

function gateEvent(base: ToolCallBase, gate: ToolGate): TurnEvent {
  return {
    type: 'tool',
    tool: {
      ...base,
      phase: 'gate',
      gate,
    },
  };
}

/** Emit observe `pre_tool` (callNotStarted) then the tool `gate` wire. */
export async function* emitGateSettlement(args: {
  base: ToolCallBase;
  gate: ToolGate;
  callId: string;
  toolName: string;
}): AsyncGenerator<TurnEvent, void> {
  yield stageEventFields('pre_tool', {
    callId: args.callId,
    toolName: args.toolName,
    callNotStarted: true,
    gate: args.gate,
  });
  yield gateEvent(args.base, args.gate);
}
