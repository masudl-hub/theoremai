import type { z } from 'zod';
import { type LabelOverrides, labelText } from '../../guardrails/labels.ts';
import type { SpanHandle } from '../../observability/trace-span.ts';
import { jsonObjectSchema } from '../provider-contract.ts';
import type { ToolAccess } from '../schema.ts';
import {
  type InjectUnit,
  runStage,
  type StageHandler,
  type StageResult,
  type StepCall,
  stageEventFields,
} from '../stages.ts';
import type { Profile, TurnEvent, TurnHistoryMessage } from '../types.ts';
import { type ToolCallBase, toolEvent } from './events.ts';
import { operationWireValue } from './operation.ts';
import { type GateDetails, gateDetails, isGateResumeGranted } from './permission.ts';
import { plainToolInput } from './schema.ts';
import type { ModelToolResult, ToolContext, ToolFailure, ToolGate, ToolLabels } from './types.ts';

/** How a call's wait for other calls in its step ended: they settled, or the wait cannot end. */
export type StepWaitOutcome =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'cycle'; callIds: string[] };

/** Holds `callId` until the calls it names have settled. */
export type StepWait = (callId: string, waitFor: readonly string[]) => Promise<StepWaitOutcome>;

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
  /** The step's calls, shown to `pre_tool`. Unset outside a turn's step. */
  stepCalls?: readonly StepCall[];
  /** Holds a call for the calls its `pre_tool` `waitFor` names. Unset outside a turn's step. */
  wait?: StepWait;
  /** The host sees a handler's drafts: `outputs.streaming.mode` `sse`. Unset outside a turn's step. */
  drafts?: boolean;
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
  | { ok: false; kind: 'gated'; gate: ToolGate; input?: unknown }
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
  labelFailed?: true;
};

/** Tool `preTool` → host `pre_tool` → mutate re-parse. */
export async function* runPreToolPipeline(args: {
  tool: {
    name: string;
    input: { safeParse: (value: unknown) => z.ZodSafeParseResult<unknown> };
    access: ToolAccess;
    labels?: ToolLabels;
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
  // why: An approval skips the tool's own check it already passed — unless the user edited the arguments.
  const approvedAsIs =
    isGateResumeGranted(ctx.resume) &&
    ctx.resume?.edited === undefined &&
    ctx.resume?.gateKind !== 'permission' &&
    ctx.resume?.gateKind !== 'auth';
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
    details: gateDetails(tool, args.input),
  });
  if (!pre.ok) {
    if (pre.kind === 'gated') {
      if ('input' in pre) {
        const candidate = pre.input;
        const parsed = tool.input.safeParse(plainToolInput(candidate));
        if (!parsed.success) {
          return {
            ok: false,
            kind: 'failed',
            failure: {
              code: 'invalid_input',
              kind: 'bad_response',
              message: labelText('tool.input_invalid_after_mutate', {}, ctx.profile.labels),
              details: parsed.error.flatten(),
            },
          };
        }
        pre.gate = {
          ...pre.gate,
          ...gateDetails(tool, parsed.data),
          preparedArguments: jsonObjectSchema.parse(operationWireValue(plainToolInput(candidate))),
        };
      }
      yield stageEventFields('pre_tool', {
        callId: base.callId,
        toolName: tool.name,
        callNotStarted: true,
        gate: pre.gate,
      });
      yield toolEvent(base, { phase: 'gate', gate: pre.gate });
    }
    return pre;
  }
  const reparsed = pre.mutated ? tool.input.safeParse(plainToolInput(pre.input)) : undefined;
  if (reparsed && !reparsed.success) {
    return {
      ok: false,
      kind: 'failed',
      failure: {
        code: 'invalid_input',
        kind: 'bad_response',
        message: labelText('tool.input_invalid_after_mutate', {}, args.ctx.profile.labels),
        details: reparsed.error.flatten(),
      },
    };
  }
  const waitFailure = await waitForStepCalls(
    stages,
    base.callId,
    tool.name,
    pre.waitFor,
    ctx.profile.labels,
  );
  if (waitFailure) return { ok: false, kind: 'failed', failure: waitFailure };
  return { ok: true, input: reparsed ? reparsed.data : pre.input };
}

async function* runPreToolStages(args: {
  stages: ToolStageSupport;
  toolName: string;
  callId: string;
  input: unknown;
  toolPreTool?: StageResult | undefined;
  details: GateDetails;
}): AsyncGenerator<
  TurnEvent,
  | Exclude<PreBodyOutcome, { ok: true }>
  | { ok: true; input: unknown; mutated: boolean; waitFor?: string[] }
> {
  const { stages, toolName, callId, input, toolPreTool, details } = args;
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
    ...(stages.stepCalls ? { stepCalls: stages.stepCalls } : {}),
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
      ...details,
    };
    return {
      ok: false,
      kind: 'gated',
      gate,
      ...(applied.mutate && 'input' in applied.mutate ? { input: applied.mutate.input } : {}),
    };
  }
  const waitFor = applied.waitFor ? { waitFor: applied.waitFor } : {};
  if (applied.mutate && 'input' in applied.mutate) {
    return { ok: true, input: applied.mutate.input, mutated: true, ...waitFor };
  }
  return { ok: true, input, mutated: false, ...waitFor };
}

/** Holds the call for the calls its `pre_tool` named; a wait that cannot end fails the call. */
async function waitForStepCalls(
  stages: ToolStageSupport | undefined,
  callId: string,
  toolName: string,
  waitFor: readonly string[] | undefined,
  labels: LabelOverrides | undefined,
): Promise<ToolFailure | undefined> {
  if (!waitFor) return undefined;
  const outcome = stages?.wait
    ? await stages.wait(callId, waitFor)
    : { ok: false as const, reason: 'unknown' as const, callIds: [...waitFor] };
  if (outcome.ok) return undefined;
  return {
    code: outcome.reason === 'unknown' ? 'wait_unknown' : 'wait_cycle',
    kind: 'request',
    message: labelText(
      outcome.reason === 'unknown' ? 'tool.wait_unknown' : 'tool.wait_cycle',
      { tool: toolName, calls: outcome.callIds.join(', ') },
      labels,
    ),
  };
}

export async function* runPostToolStages(args: {
  stages: ToolStageSupport;
  toolName: string;
  callId: string;
  input?: unknown;
  callNotStarted?: boolean;
  outputRaw?: unknown;
  outputModel?: ModelToolResult;
  activityPast?: string;
  activityFailed?: string;
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
    ...(applied.labelFailed ? { labelFailed: true as const } : {}),
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
  labels: LabelOverrides | undefined;
}): AsyncGenerator<TurnEvent, string | undefined> {
  yield stageEventFields('pre_tool', {
    callId: args.callId,
    toolName: args.toolName,
    callNotStarted: true,
    gate: args.gate,
  });
  const readBack =
    args.gate.kind === 'auth'
      ? labelText('sign_in.pending', { service: args.gate.authChallenge.service }, args.labels)
      : undefined;
  yield toolEvent(args.base, { phase: 'gate', gate: args.gate, ...(readBack ? { readBack } : {}) });
  return readBack;
}
