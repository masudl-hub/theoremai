/**
 * Shared pre_tool / post_tool stage application for tool execute paths.
 *
 * Contract: `docs/contracts/stages.md` (slice 2).
 *
 * @module
 */

import {
  applyStageResult,
  type StageHandler,
  type StageResult,
  stageEventFields,
} from '../stages.ts';
import type { TurnEvent, TurnHistoryMessage } from '../types.ts';
import { isGateResumeGranted } from './permission.ts';
import type { ModelToolResult, ToolContext, ToolFailure, ToolGate } from './types.ts';

/** Stage wiring passed into `executeRegisteredTool`. */
export interface ToolStageSupport {
  /** Ordered host handlers: request `onStage`, then turn/session ambient. */
  handlers: StageHandler[];
  step: number;
  history: () => readonly TurnHistoryMessage[];
  injectAllowed: boolean;
  injectWouldExceedMaxSteps?: boolean;
  /** Apply sanitized inject messages; return how many were appended. */
  applyInject?: (messages: TurnHistoryMessage[]) => number;
  host?: unknown;
  signal?: AbortSignal;
}

/** Empty host stage support when only a tool-local `preTool` is present. */
function defaultToolStageSupport(ctx: {
  turn?: { step?: number };
  host?: unknown;
  signal?: AbortSignal;
}): ToolStageSupport {
  return {
    handlers: [],
    step: ctx.turn?.step ?? 1,
    history: () => [],
    injectAllowed: false,
    host: ctx.host,
    signal: ctx.signal,
  };
}

export type PreToolStageOutcome =
  | { kind: 'proceed'; input: unknown }
  | { kind: 'deny'; failure: ToolFailure }
  | { kind: 'gate'; gate: ToolGate }
  | { kind: 'abort'; abort: true | { reason?: string } }
  | { kind: 'error'; failure: ToolFailure };

export type PostToolStageOutcome = {
  abort?: boolean | { reason?: string };
  injectCount: number;
  /** Inject messages for the caller to apply after recording the tool result. */
  inject?: TurnHistoryMessage[];
};

/**
 * Await tool-local `preTool` (skipped when resume.granted), then run host pre_tool stages.
 * Returns `passthrough` when neither tool nor host stages apply.
 */
export async function* runPreToolPipeline(args: {
  tool: {
    name: string;
    preTool?: (
      input: never,
      ctx: ToolContext,
    ) => StageResult | undefined | Promise<StageResult | undefined>;
  };
  input: unknown;
  ctx: ToolContext;
  callId: string;
  stages?: ToolStageSupport;
}): AsyncGenerator<
  TurnEvent,
  { status: 'passthrough'; input: unknown } | { status: 'ran'; outcome: PreToolStageOutcome }
> {
  let toolPreTool: StageResult | undefined;
  if (args.tool.preTool && !isGateResumeGranted(args.ctx.resume)) {
    toolPreTool = (await args.tool.preTool(args.input as never, args.ctx)) ?? undefined;
  }
  if (!args.stages && toolPreTool === undefined) {
    return { status: 'passthrough', input: args.input };
  }
  const support = args.stages ?? defaultToolStageSupport(args.ctx);
  const outcome = yield* runPreToolStages({
    stages: support,
    toolName: args.tool.name,
    callId: args.callId,
    input: args.input,
    toolPreTool,
  });
  return { status: 'ran', outcome };
}

function mergeStageResults(parts: StageResult[]): StageResult {
  const out: StageResult = {};
  for (const part of parts) {
    if (part.abort !== undefined) out.abort = part.abort;
    if (part.deny) out.deny = part.deny;
    if (part.confirm !== undefined && !out.deny) out.confirm = part.confirm;
    if (part.mutate) out.mutate = part.mutate;
    if (part.inject?.length) {
      out.inject = [...(out.inject ?? []), ...part.inject];
    }
  }
  return out;
}

async function collectHandlerResults(
  handlers: Array<() => StageResult | undefined | Promise<StageResult | undefined>>,
): Promise<StageResult[]> {
  const parts: StageResult[] = [];
  for (const run of handlers) {
    const raw = await run();
    if (raw && typeof raw === 'object') parts.push(raw);
  }
  return parts;
}

/**
 * Emit `pre_tool`, run tool `preTool` then host handlers, apply affordances.
 */
async function* runPreToolStages(args: {
  stages: ToolStageSupport;
  toolName: string;
  callId: string;
  input: unknown;
  /** Tool-local `preTool` return (already awaited by caller if needed). */
  toolPreTool?: StageResult | undefined;
  /** When set, host confirm is skipped — declarative gate already decided. */
  skipHostConfirm?: boolean;
}): AsyncGenerator<TurnEvent, PreToolStageOutcome> {
  const { stages, toolName, callId, input } = args;
  const stageEv = stageEventFields('pre_tool', {
    callId,
    toolName,
  });
  yield stageEv;

  const ctxBase = {
    stage: 'pre_tool' as const,
    step: stages.step,
    history: stages.history(),
    host: stages.host,
    callId,
    tool: toolName,
    input,
  };

  const runners: Array<() => StageResult | undefined | Promise<StageResult | undefined>> = [];
  if (args.toolPreTool !== undefined) {
    runners.push(() => args.toolPreTool);
  }
  for (const handler of stages.handlers) {
    runners.push(() => handler({ ...ctxBase }));
  }

  let rawParts: StageResult[];
  try {
    rawParts = await collectHandlerResults(runners);
  } catch (err) {
    if (stages.signal?.aborted) throw err;
    throw err;
  }

  const merged = mergeStageResults(rawParts);
  const applied = applyStageResult({
    stage: 'pre_tool',
    result: merged,
    injectAllowed: false,
  });

  if (applied.warnings.length > 0) {
    yield {
      type: 'stage',
      stage: 'pre_tool',
      stageWarnings: applied.warnings,
      callId,
      toolName,
    };
  }

  if (applied.abort) {
    return { kind: 'abort', abort: applied.abort === true ? true : applied.abort };
  }
  if (applied.deny) {
    return {
      kind: 'deny',
      failure: {
        code: applied.deny.code,
        message: applied.deny.message,
      },
    };
  }
  if (applied.confirm && !args.skipHostConfirm) {
    const gate: ToolGate = {
      kind: 'confirmation',
      tool: toolName,
      ...(applied.confirm.summary ? { summary: applied.confirm.summary } : {}),
    };
    yield stageEventFields('pre_tool', {
      callId,
      toolName,
      callNotStarted: true,
      gate,
    });
    return {
      kind: 'gate',
      gate,
    };
  }
  if (applied.mutate) {
    return { kind: 'proceed', input: applied.mutate.input };
  }
  return { kind: 'proceed', input };
}

/**
 * Emit `post_tool`, run host handlers, apply inject/abort.
 */
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
}): AsyncGenerator<TurnEvent, PostToolStageOutcome> {
  const { stages, toolName, callId } = args;
  yield stageEventFields('post_tool', {
    callId,
    toolName,
    callNotStarted: args.callNotStarted,
    awaiting: args.awaiting,
  });

  if (stages.handlers.length === 0) {
    return { injectCount: 0 };
  }

  const ctx = {
    stage: 'post_tool' as const,
    step: stages.step,
    history: stages.history(),
    host: stages.host,
    callId,
    tool: toolName,
    input: args.input,
    callNotStarted: args.callNotStarted,
    outputRaw: args.outputRaw,
    outputModel: args.outputModel,
    failure: args.failure,
    awaiting: args.awaiting,
  };

  const parts = await collectHandlerResults(stages.handlers.map((h) => () => h(ctx)));
  const merged = mergeStageResults(parts);
  const applied = applyStageResult({
    stage: 'post_tool',
    result: merged,
    injectAllowed: stages.injectAllowed,
    injectWouldExceedMaxSteps: stages.injectWouldExceedMaxSteps,
  });

  if (applied.warnings.length > 0) {
    yield {
      type: 'stage',
      stage: 'post_tool',
      stageWarnings: applied.warnings,
      callId,
      toolName,
    };
  }

  let injectCount = 0;
  // Prefer returning inject for the runner to apply after recording the provider
  // tool result (Interactions continuation must exist first). When applyInject is
  // set and the caller wants immediate apply (e.g. invokeTool), use it.
  if (applied.inject?.length) {
    if (stages.applyInject) {
      injectCount = stages.applyInject(applied.inject);
      return {
        injectCount,
        ...(applied.abort !== undefined ? { abort: applied.abort } : {}),
      };
    }
    return {
      injectCount: applied.inject.length,
      inject: applied.inject,
      ...(applied.abort !== undefined ? { abort: applied.abort } : {}),
    };
  }

  return {
    injectCount,
    ...(applied.abort !== undefined ? { abort: applied.abort } : {}),
  };
}

export function gateEvent(
  base: { name: string; callId?: string; arguments?: Record<string, unknown> },
  gate: ToolGate,
): TurnEvent {
  return {
    type: 'tool',
    tool: {
      ...base,
      phase: 'gate',
      gate,
    },
  };
}

/**
 * Emit observe `pre_tool` (callNotStarted) then the tool `gate` wire.
 */
export async function* emitGateSettlement(args: {
  base: { name: string; callId?: string; arguments?: Record<string, unknown> };
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
