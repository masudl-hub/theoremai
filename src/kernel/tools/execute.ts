import { z } from 'zod';
import { type ToolBoundary, type ToolKind, toolBoundary } from '../../guardrails/boundaries.ts';
import { checkDestinationGate } from '../../guardrails/destinations.ts';
import { type DetectScope, scopeOf } from '../../guardrails/detect-at.ts';
import { errorKind, isAbortError, TheoremError, throwIfAborted } from '../../guardrails/error.ts';
import { type LabelOverrides, labelText } from '../../guardrails/labels.ts';
import { resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import {
  checkTaintGate,
  guardToolFailureText,
  guardToolResult,
  guardToolValue,
  inspectToolArguments,
  toolCallEvent,
} from '../../guardrails/tool-result.ts';
import type {
  GuardrailHit,
  Provenance,
  ResolvedGuardrailPolicy,
  ToolOrigin,
} from '../../guardrails/types.ts';
import type { SpanHandle, TraceAttributes } from '../../observability/trace-span.ts';
import {
  recordToolCheck,
  startToolTrace,
  type ToolCallEnd,
  type ToolOutcome,
} from '../engine/tool-trace.ts';
import { sumTurnTokens } from '../engine/usage.ts';
import { jsonObjectSchema } from '../json.ts';
import { isTextFile, textFileData, textFileText } from '../registry/attachments.ts';
import type { InjectUnit } from '../stages.ts';
import {
  isAwaitingUserInput,
  type Source,
  type ToolOutputPart,
  toolOutputPartRecord,
} from '../turn-events.ts';
import type { Profile, ToolId, TurnEvent, TurnTokens } from '../types.ts';
import { isRecord } from '../util/record.ts';
import { fillActivityLabel } from './activity-label.ts';
import { type AgentCaller, agentToolOrigin } from './agent.ts';
import { planDetach, splitBackground, type ToolBackgroundSupport } from './background.ts';
import { coordinateTool } from './coordinate.ts';
import {
  dispatchToolBody,
  failedActivity,
  failedActivityOf,
  failureEvent,
  type HandOff,
  messageOf,
  networkBlocked,
  networkBlockedEvent,
  requestChecks,
  sourceEvents,
  startToolExecution,
  type ToolCallBase,
  toolCallArguments,
  toolEvent,
} from './events.ts';
import { ToolFailed } from './failed.ts';
import { type HandlerEventChecks, HandlerEvents } from './handler-events.ts';
import { fetchToolMedia } from './image-fetch.ts';
import { formatToolFailureForModel, formatToolResult, frameToolFailure } from './model-text.ts';
import { agentOutputSchema, markedFieldsIn, outputForModel } from './model-view.ts';
import type {
  ToolExecutionCoordinator,
  ToolOperationClaim,
  ToolOperationOutcome,
} from './operation.ts';
import { operationBroken, operationWireValue } from './operation.ts';
import {
  checkPermission,
  gateDetails,
  isGateResumeDenied,
  isGateResumeGranted,
  isResumeContinuation,
} from './permission.ts';
import type { ToolRegistry } from './registry.ts';
import {
  type CredentialQuery,
  executeHttpTool,
  executeMcpTool,
  failureWithoutSecret,
  modelResultFromOutput,
  omitSecret,
  outcomeFromUnauth,
  parseToolOutput,
  refusedCredentialOutcome,
  resolveToolAuth,
  withMedia,
} from './remote.ts';
import {
  extractLoadedIds,
  profileToolAllow,
  profileToolsSpec,
  promoteLoadedTools,
} from './resolve.ts';
import { plainToolInput } from './schema.ts';
import { CredentialRefusedError, signedInFetch } from './signed-in-fetch.ts';
import {
  emitGateSettlement,
  type PostToolStageOutcome,
  runPostToolStages,
  runPreToolPipeline,
  type ToolStageSupport,
} from './stage-run.ts';
import type {
  AgentToolInput,
  AgentToolOutput,
  FunctionToolDef,
  HttpToolDef,
  McpToolDef,
  ModelToolResult,
  RegisteredAgentTool,
  RegisteredTool,
  ToolBodyOutcome,
  ToolContext,
  ToolFailure,
  ToolGate,
  ToolLabels,
  ToolStreamEvent,
  TurnToolSnapshot,
} from './types.ts';

export {
  checkPermission,
  isGateResumeGranted,
  isResumeContinuation,
  permissionGranted,
} from './permission.ts';

import { checkedToolOutputParts, toolOutputPartIssues } from './output-parts.ts';
import { type SchemaIssue, schemaIssueDetails } from './schema-issues.ts';
import { UncheckedOutput } from './unchecked-output.ts';

export function originOfTool(tool: RegisteredTool, tools: ToolRegistry): ToolOrigin {
  if (tool.type === 'agent') return agentToolOrigin(tools.findProfile(tool.profile));
  if (tool.type === 'http') return 'http';
  if (tool.type === 'mcp') return 'mcp';
  if (tool.type === 'builtin') return 'builtin';
  return 'local';
}

/** The kind whose boundaries a tool's calls cross. A provider builtin crosses none. */
function toolKindOf(tool: RegisteredTool): ToolKind | undefined {
  return tool.type === 'builtin' ? undefined : tool.type;
}

/**
 * The boundary a call of `name` is read at before its tool gets it: none for a provider builtin,
 * whose text the kernel never reads. A call no tool takes is read as a function tool's.
 */
export function toolArgumentsBoundary(tools: ToolRegistry, name: string): ToolBoundary | undefined {
  const tool = tools.get(name);
  const kind = tool ? toolKindOf(tool) : 'function';
  return kind && toolBoundary('tool_arguments', kind);
}

/** A delegated reply is one hop past the called agent's own tools. */
function provenanceFor(tool: RegisteredTool, tools: ToolRegistry): Provenance {
  const origin = originOfTool(tool, tools);
  return { origin, tool: tool.name, depth: origin === 'delegated' ? 2 : 1 };
}

function isStreamHandler(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    Object.prototype.toString.call(handler) === '[object AsyncGeneratorFunction]'
  );
}

/** A tool's output without its `parts` key, which carries media the model receives separately; any other value is returned as it is. */
export function leanToolResultData(output: unknown): unknown {
  if (!isRecord(output)) return output;
  const { parts: _parts, ...rest } = output;
  return rest;
}

async function* runHandler<TIn, TOut>(
  handler: FunctionToolDef<TIn, TOut>['handler'],
  input: TIn,
  ctx: ToolContext,
  shown: HandlerEvents,
): AsyncGenerator<TurnEvent, unknown> {
  if (isStreamHandler(handler)) {
    let output: TOut | undefined;
    const gen = (
      handler as (input: TIn, ctx: ToolContext) => AsyncGenerator<ToolStreamEvent<TOut>>
    )(input, ctx);
    for await (const event of gen) {
      throwIfAborted(ctx.signal);
      if (event.kind === 'complete') {
        output = event.output;
        continue;
      }
      yield* shown.show(event);
    }
    yield* shown.end();
    return output;
  }
  const output = await handler(input, ctx);
  return output instanceof UncheckedOutput ? output.value : output;
}

/** What the model is told of a function tool's output: a fixed finding for a hidden tool, a finding plus the output for an awaiting-user result, otherwise the tool's own summary or finding and its data. */
export function projectForModel(
  tool: FunctionToolDef,
  output: unknown,
  labels?: LabelOverrides,
): ModelToolResult {
  const media = checkedToolOutputParts(output);
  if (tool.exposeToModel === false) {
    // why: The model reads none of a hidden tool's output, its media included; what it sent, the person is shown.
    const sent = media?.filter((part) => part.type !== 'text' && ('uri' in part || part.sent));
    return {
      finding: labelText('tool.completed_hidden', {}, labels),
      hidden: true,
      ...(sent?.length ? { media: sent } : {}),
    };
  }
  const seen = outputForModel(tool.outputSchema, output);
  if (isAwaitingUserInput(output)) {
    return {
      finding: labelText(
        'tool.awaiting_user',
        { kind: output.kind, prompt: output.prompt },
        labels,
      ),
      data: leanToolResultData(seen),
    };
  }
  const lean = leanToolResultData(seen);
  const summarized = isRecord(lean) && 'finding' in lean;
  const { finding: summary, ...rest } = summarized ? lean : {};
  const result = summarized
    ? {
        finding: String(summary),
        ...(Object.keys(rest).length > 0 ? { data: rest } : {}),
      }
    : modelResultFromOutput(lean, undefined);
  return withMedia(result, media);
}

/** How the call's `post_tool` stage gets the output as the model reads it; nothing when the model reads none. */
function forModelOf(tool: { exposeToModel?: boolean; outputSchema: Record<string, unknown> }): {
  forModel?: (output: unknown) => unknown;
} {
  if (tool.exposeToModel === false) return {};
  return { forModel: (output) => outputForModel(tool.outputSchema, output) };
}

function loadsT2(tool: FunctionToolDef, ctx: ToolContext): boolean {
  return profileToolsSpec(ctx.profile)?.t2Loader === tool.name;
}

function applyT2LoaderPromotion(
  tools: ToolRegistry,
  tool: FunctionToolDef,
  checkedData: unknown,
  ctx: ToolContext,
  snapshot: TurnToolSnapshot | undefined,
): { ok: true; output: unknown } | { ok: false; failure: ToolFailure } {
  if (!loadsT2(tool, ctx)) {
    return { ok: true, output: checkedData };
  }
  if (!snapshot) {
    return {
      ok: false,
      failure: {
        code: 'invalid_output',
        kind: 'bad_response',
        message: labelText(
          'tool.t2_loader_needs_snapshot',
          { tool: tool.name },
          ctx.profile.labels,
        ),
      },
    };
  }
  const loaded = extractLoadedIds(checkedData);
  if (!loaded) {
    return {
      ok: false,
      failure: {
        code: 'invalid_output',
        kind: 'bad_response',
        message: labelText('tool.t2_loader_shape', { tool: tool.name }, ctx.profile.labels),
      },
    };
  }
  const { promoted, failure: promoteFailure } = promoteLoadedTools(
    tools,
    snapshot,
    loaded,
    ctx.profile,
  );
  if (promoteFailure) {
    return { ok: false, failure: promoteFailure };
  }
  const finalOutput = { ...(checkedData as Record<string, unknown>), loaded: promoted };
  const rechecked = tool.output.safeParse(finalOutput);
  if (!rechecked.success) {
    return {
      ok: false,
      failure: {
        code: 'invalid_output',
        kind: 'bad_response',
        message: labelText('tool.t2_loader_output_invalid', {}, ctx.profile.labels),
        details: schemaIssueDetails(rechecked.error.issues),
      },
    };
  }
  return { ok: true, output: rechecked.data };
}

export type ToolExecuteSettlement = {
  modelResult?: ModelToolResult;
  gated?: ToolGate;
  /** A sign-in gate's note to the model; the gate event carries it as `readBack`. */
  gateReadBack?: string;
  aborted?: boolean | { reason?: string };
  callNotStarted?: boolean;
  awaiting?: boolean;
  failure?: ToolFailure;
  /** Set when the body completed, including awaiting. */
  outputRaw?: unknown;
  denied?: true;
  /** Landed after the provider tool result is recorded: the Interactions continuation must exist first. */
  pendingInject?: InjectUnit[];
  /** `post_tool` ended the turn: no model step follows this call's step. */
  ended?: true;
};

/** Unguarded; `settleToolCall` guards the result. */
type Reproject = (
  output: unknown,
) =>
  | { ok: true; outputRaw: unknown; modelResult: ModelToolResult }
  | { ok: false; failure: ToolFailure };

/** Guards what the model reads back from a call: a result, or a failure's message and then its framing. */
interface ResultGuard {
  result: (result: ModelToolResult) => Generator<TurnEvent, GuardedResult>;
  failure: (failure: ToolFailure) => Generator<TurnEvent, GuardedResult>;
  /** What the handler's events are read against before its output; `drafts`: whether the host sees its drafts. */
  handlerEvents: (drafts: boolean) => HandlerEventChecks | undefined;
  /** What the person is shown of a value the call settles with, apart from what the model reads. */
  shown: (value: unknown) => Generator<TurnEvent, unknown>;
  /** The parts the person is shown, each read with a text file's bytes decoded; one a match blocks is left out. */
  shownParts: (parts: readonly ToolOutputPart[]) => Generator<TurnEvent, ToolOutputPart[]>;
}

/** What the model reads back from a call. */
interface GuardedResult {
  modelResult: ModelToolResult;
  /** Set when the output was blocked at its boundary: the call settles as this failure. */
  withheld?: ToolFailure;
}

type Provisional =
  | { outputRaw: unknown; modelResult: ModelToolResult }
  | {
      failure: ToolFailure;
      callNotStarted?: boolean;
      denied?: true;
    };

/** What a post-tool stage's deny or `mutate` settles the call with instead; `undefined` when it keeps the result. */
function* reviseAfterStages(
  post: PostToolStageOutcome,
  guard: ResultGuard,
  reproject: Reproject | undefined,
  failure: ToolFailure | undefined,
): Generator<TurnEvent, Revised | undefined> {
  if (post.deny) {
    return yield* failedWith(guard, {
      code: post.deny.code,
      kind: 'blocked',
      message: post.deny.message,
      ...(post.deny.details ? { details: post.deny.details } : {}),
    });
  }
  if (post.mutate && 'details' in post.mutate) {
    if (!failure) return undefined;
    return yield* failedWith(guard, { ...failure, details: post.mutate.details });
  }
  if (!post.mutate || !reproject) return undefined;
  const next = reproject(plainToolInput(post.mutate.output));
  if (!next.ok) return yield* failedWith(guard, next.failure);
  const guarded = yield* guard.result(next.modelResult);
  if (guarded.withheld) {
    return {
      failure: guarded.withheld,
      outputRaw: undefined,
      modelResult: guarded.modelResult,
      awaiting: false,
    };
  }
  return {
    outputRaw: next.outputRaw,
    modelResult: guarded.modelResult,
    awaiting: isAwaitingUserInput(next.outputRaw),
  };
}

/** The call settled as `failure`, or as `output_blocked` when the guard blocked its details. */
function* failedWith(guard: ResultGuard, failure: ToolFailure): Generator<TurnEvent, Revised> {
  const guarded = yield* guard.failure(failure);
  return {
    failure: guarded.withheld ?? failure,
    outputRaw: undefined,
    modelResult: guarded.modelResult,
    awaiting: false,
  };
}

function pastActivity(
  labels: ToolLabels | undefined,
  input: unknown,
  output: unknown,
): string | undefined {
  return fillActivityLabel(labels?.activityPast, { input, output });
}

function completeEvent(
  base: ToolCallBase,
  settled: {
    input: unknown;
    outputRaw: unknown;
    modelResult: ModelToolResult;
    parts: readonly ToolOutputPart[];
    labels?: ToolLabels;
    labelFailed?: true;
  },
): TurnEvent {
  const { input, outputRaw, modelResult, parts } = settled;
  const activityPast = settled.labelFailed
    ? failedActivityOf(base)
    : pastActivity(settled.labels, input, outputRaw);
  return toolEvent(base, {
    phase: 'complete',
    output: outputRaw,
    readBack: formatToolResult(modelResult),
    ...(parts.length ? { parts: [...parts] } : {}),
    ...(modelResult.hidden ? { hidden: true as const } : {}),
    ...(activityPast ? { activityPast } : {}),
  });
}

/**
 * The one settlement for every transport. `reproject` is absent when the kernel owns the
 * output (the T2 loader), which makes a host `mutate` a warning instead of a replacement.
 */
async function* settleToolCall(args: {
  base: ToolCallBase;
  toolName: string;
  callId: string;
  input?: unknown;
  stages?: ToolStageSupport;
  provisional: Provisional;
  guard: ResultGuard;
  reproject?: Reproject;
  /** The output as the model reads it, before it becomes text. */
  forModel?: (output: unknown) => unknown;
  /** Run on the output the call settles with, after any `mutate`. */
  sources?: (output: unknown) => Source[];
  /** Fetches the pictures the settled output names; runs only for a result the guard let through. */
  media?: (output: unknown) => ReturnType<typeof fetchToolMedia>;
  labels?: ToolLabels;
}): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { base, input, stages, provisional, guard, sources } = args;
  const guarded = yield* 'failure' in provisional
    ? guard.failure(provisional.failure)
    : guard.result(provisional.modelResult);
  let modelResult = guarded.modelResult;
  let failure = guarded.withheld ?? ('failure' in provisional ? provisional.failure : undefined);
  let outputRaw = 'outputRaw' in provisional && !failure ? provisional.outputRaw : undefined;
  const callNotStarted = 'callNotStarted' in provisional ? provisional.callNotStarted : undefined;
  let denied = 'denied' in provisional ? provisional.denied : undefined;
  let awaiting = !failure && isAwaitingUserInput(outputRaw);
  let post: PostToolStageOutcome | undefined;

  if (stages) {
    let revised: Revised | undefined;
    ({ post, revised } = yield* postToolOf(args, stages, {
      callNotStarted,
      outputRaw,
      modelResult,
      failure,
      awaiting,
    }));
    if (revised) {
      ({ failure, outputRaw, modelResult, awaiting } = revised);
      if (post.deny) denied = true;
    }
  }

  if (!failure) {
    modelResult = yield* citeAndShow({
      base,
      sources,
      media: args.media,
      outputRaw,
      modelResult,
    });
  }
  yield failure
    ? failureEvent(
        base,
        {
          ...failure,
          message: String(yield* guard.shown(failure.message)),
          ...(failure.details === undefined
            ? {}
            : { details: yield* guard.shown(failure.details) }),
        },
        formatToolResult(modelResult),
      )
    : completeEvent(base, {
        input,
        outputRaw: shownFiles(yield* guard.shown(withFileTexts(outputRaw)), outputRaw),
        modelResult,
        parts: yield* guard.shownParts(modelResult.media ?? []),
        labels: args.labels,
        ...(post?.labelFailed ? { labelFailed: true as const } : {}),
      });
  return {
    modelResult,
    ...(failure ? { failure } : { outputRaw }),
    ...(denied ? { denied } : {}),
    ...(callNotStarted ? { callNotStarted: true as const } : {}),
    ...(awaiting ? { awaiting: true as const } : {}),
    ...stageSettlement(post),
  };
}

type Revised = {
  failure?: ToolFailure;
  outputRaw: unknown;
  modelResult: ModelToolResult;
  awaiting: boolean;
};

/** The host's post_tool stages on the call as it stands, and what their deny or `mutate` settles it with instead. */
async function* postToolOf(
  args: Parameters<typeof settleToolCall>[0],
  stages: ToolStageSupport,
  now: {
    callNotStarted: boolean | undefined;
    outputRaw: unknown;
    modelResult: ModelToolResult;
    failure: ToolFailure | undefined;
    awaiting: boolean;
  },
): AsyncGenerator<TurnEvent, { post: PostToolStageOutcome; revised: Revised | undefined }> {
  const { base, toolName, callId, input, guard, reproject, forModel } = args;
  const { outputRaw, failure } = now;
  const activityPast = failure ? undefined : pastActivity(args.labels, input, outputRaw);
  const post = yield* runPostToolStages({
    stages,
    toolName,
    callId,
    input,
    callNotStarted: now.callNotStarted,
    outputRaw,
    ...(outputRaw !== undefined && forModel ? { outputForModel: forModel(outputRaw) } : {}),
    outputModel: now.modelResult,
    ...(activityPast ? { activityPast } : {}),
    activityFailed: failedActivityOf(base),
    failure,
    awaiting: now.awaiting || undefined,
    mutates: failure ? 'details' : reproject ? 'output' : undefined,
  });
  return { post, revised: yield* reviseAfterStages(post, guard, reproject, failure) };
}

/** The settled output's cited sources, then the media its tool names; the result carrying them. */
async function* citeAndShow(args: {
  base: ToolCallBase;
  sources: ((output: unknown) => Source[]) | undefined;
  media: ((output: unknown) => ReturnType<typeof fetchToolMedia>) | undefined;
  outputRaw: unknown;
  modelResult: ModelToolResult;
}): AsyncGenerator<TurnEvent, ModelToolResult> {
  const { base, sources, media, outputRaw, modelResult } = args;
  if (sources) yield* sourceEvents(base, sources, outputRaw);
  if (!media || outputRaw === undefined) return modelResult;
  return yield* withNamedMedia(base, modelResult, media, outputRaw);
}

/**
 * The result with the media its tool names, the pictures fetched after the guard and the stages
 * passed it. The addresses fetched are written into the result's text, so the egress rule on
 * pictures the model shows counts them as given by a tool; a reference's address never is.
 */
async function* withNamedMedia(
  base: ToolCallBase,
  result: ModelToolResult,
  named: (output: unknown) => ReturnType<typeof fetchToolMedia>,
  outputRaw: unknown,
): AsyncGenerator<TurnEvent, ModelToolResult> {
  const fetched = await named(outputRaw);
  if (fetched.warning) yield toolEvent(base, { phase: 'warning', warning: fetched.warning });
  if (fetched.media.length === 0) return result;
  const withAll = withMedia(result, [...(result.media ?? []), ...fetched.media]);
  if (fetched.urls.length === 0) return withAll;
  const note = `\n[Pictures shown with this result: ${fetched.urls.join(' ')}]`; // labels-exempt: a marker the egress rule reads the addresses from, not prose (P2)
  return {
    ...withAll,
    ...(result.modelText !== undefined
      ? { modelText: result.modelText + note }
      : { finding: result.finding + note }),
  };
}

/** What the after-call stages add to a settlement: a turn to stop or end, input to hand the model. */
function stageSettlement(
  post: PostToolStageOutcome | undefined,
): Pick<ToolExecuteSettlement, 'aborted' | 'pendingInject' | 'ended'> {
  return {
    ...(post?.abort !== undefined ? { aborted: post.abort } : {}),
    ...(post?.inject.length ? { pendingInject: post.inject } : {}),
    ...(post?.end ? { ended: true as const } : {}),
  };
}

function settleToolFailure(
  guard: ResultGuard,
  base: ToolCallBase,
  failure: ToolFailure,
  stages: ToolStageSupport | undefined,
  args: {
    toolName: string;
    callId: string;
    input?: unknown;
    callNotStarted?: boolean;
    denied?: true;
  },
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  return settleToolCall({
    base,
    toolName: args.toolName,
    callId: args.callId,
    input: args.input,
    stages,
    guard,
    provisional: {
      failure,
      ...(args.callNotStarted ? { callNotStarted: true } : {}),
      ...(args.denied ? { denied: true } : {}),
    },
  });
}

function resultGuard(
  tools: ToolRegistry,
  tool: RegisteredTool,
  ctx: ToolContext,
  snapshot: TurnToolSnapshot | undefined,
  span: SpanHandle | undefined,
): ResultGuard {
  const provenance = provenanceFor(tool, tools);
  const policy = resolveGuardrailPolicy(ctx.profile.guardrails);
  const callableTools = snapshot?.executable ?? [];
  const inputs: GuardInputs = {
    provenance,
    policy,
    kind: toolKindOf(tool),
    callableTools,
    labels: ctx.profile.labels,
    span,
  };
  const { kind } = inputs;
  const handlerEvents = (drafts: boolean): HandlerEventChecks | undefined =>
    kind && {
      profileId: ctx.profile.id,
      provenance,
      policy,
      boundary: toolBoundary('tool_output', kind),
      shown: toolBoundary('tool_shown', kind),
      callableTools,
      drafts,
    };
  const shown = (value: unknown) => showValue(value, inputs);
  const shownParts = (parts: readonly ToolOutputPart[]) => showParts(parts, inputs);
  const service = isGateResumeGranted(ctx.resume) ? signInService(tool, ctx.resume) : undefined;
  if (!service) {
    return {
      result: (result) => guardResult(result, inputs),
      failure: (failure) => guardFailure(failure, inputs),
      handlerEvents,
      shown,
      shownParts,
    };
  }
  const note = labelText('sign_in.done', { service }, ctx.profile.labels);
  return {
    result: (result) => afterSignIn(note, guardResult(result, inputs)),
    failure: (failure) => afterSignIn(note, guardFailure(failure, inputs)),
    handlerEvents,
    shown,
    shownParts,
  };
}

/** A call the person signed in for tells the model so before what it read back. */
function* afterSignIn(
  note: string,
  guarded: Generator<TurnEvent, GuardedResult>,
): Generator<TurnEvent, GuardedResult> {
  const read = yield* guarded;
  const modelText = `${note}\n\n${formatToolResult(read.modelResult)}`;
  return { ...read, modelResult: { ...read.modelResult, modelText } };
}

async function* runFunctionPreBodyStages(args: {
  tool: FunctionToolDef;
  input: unknown;
  ctx: ToolContext;
  base: ToolCallBase;
  stages?: ToolStageSupport;
  guard: ResultGuard;
}): AsyncGenerator<TurnEvent, { ok: true; input: unknown } | ToolExecuteSettlement> {
  const { tool, base, stages, guard } = args;
  const pre = yield* runPreToolPipeline(args);
  if (pre.ok) return pre;
  if (pre.kind === 'aborted') {
    return { aborted: pre.aborted, callNotStarted: true };
  }
  if (pre.kind === 'gated') {
    return { gated: pre.gate, callNotStarted: true };
  }
  return yield* settleToolFailure(guard, base, pre.failure, stages, {
    toolName: tool.name,
    callId: base.callId,
    input: args.input,
    callNotStarted: true,
    ...(pre.denied ? { denied: true } : {}),
  });
}

type ParsedOutput =
  | { success: true; data: unknown }
  | { success: false; error: { issues: readonly SchemaIssue[] } };

/** `value` checked by the tool's own output schema, then its `parts` by `toolOutputPartSchema`. */
function checkOutput(tool: FunctionToolDef, value: unknown): ParsedOutput {
  const checked = tool.output.safeParse(value);
  if (!checked.success) return checked;
  const issues = toolOutputPartIssues(checked.data);
  return issues.length > 0 ? { success: false, error: { issues } } : checked;
}

function makeReproject(
  parse: (value: unknown) => ParsedOutput,
  project: (data: unknown) => ModelToolResult,
  labels: LabelOverrides | undefined,
): Reproject {
  return (output) => {
    const checked = parse(output);
    if (!checked.success) {
      return {
        ok: false,
        failure: {
          code: 'invalid_output',
          kind: 'bad_response',
          message: labelText('tool.output_invalid_after_mutate', {}, labels),
          details: schemaIssueDetails(checked.error.issues),
        },
      };
    }
    return { ok: true, outputRaw: checked.data, modelResult: project(checked.data) };
  };
}

type FunctionSignIn = {
  /** Set when the tool signs in and its credential resolved. */
  prepared?: { authHeaders: Record<string, string>; query?: CredentialQuery; audience?: string };
  secret?: string;
  /** Set when the call settles here: a gate, the model told it is not signed in, or a failure. */
  outcome?: ToolBodyOutcome;
};

/** Order as for remote tools: schema → permission → auth → preTool/host stages → body. */
async function* resolveFunctionSignIn(
  tool: FunctionToolDef,
  ctx: ToolContext,
  base: ToolCallBase,
): AsyncGenerator<TurnEvent, FunctionSignIn> {
  if (!tool.auth) return {};
  const resolved = yield* resolveToolAuth(tool.name, tool.auth, ctx, base);
  const outcome = outcomeFromUnauth(resolved);
  if (outcome) return { outcome };
  return {
    prepared: {
      authHeaders: resolved.headers,
      ...(resolved.query ? { query: resolved.query } : {}),
      ...(resolved.audience ? { audience: resolved.audience } : {}),
    },
    ...(resolved.secret ? { secret: resolved.secret } : {}),
  };
}

function functionHandlerFailure(error: unknown): ToolFailure {
  return {
    code: 'handler_error',
    kind: error instanceof TheoremError ? error.kind : 'failed',
    message: messageOf(error),
  };
}

function waitsForPage(tool: FunctionToolDef, ctx: ToolContext): boolean {
  return tool.answeredBy === 'page' && ctx.page === undefined && !ctx.pageExecution;
}

async function* receivePageAnswer(
  tool: FunctionToolDef,
  ctx: ToolContext,
  handOff: HandOff,
  base: ToolCallBase,
): AsyncGenerator<TurnEvent, ToolContext> {
  const execution = ctx.pageExecution;
  if (tool.answeredBy !== 'page' || !execution) return ctx;
  const claim = await handOff.claim();
  if (!claim?.invocation) {
    throw new TheoremError(
      'config',
      `Page tool '${tool.name}' needs a tool execution coordinator (execution)`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const argumentsForPage = jsonObjectSchema.parse(
    operationWireValue(claim.invocation.preparedInput),
  );
  const dispatch = await execution.dispatch(claim, ctx.signal);
  throwIfAborted(ctx.signal);
  if (!dispatch.grantId) throw operationBroken('The page dispatch returned no grantId'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  yield toolEvent(base, {
    phase: 'dispatch',
    grantId: dispatch.grantId,
    arguments: argumentsForPage,
  });
  ctx = { ...ctx, page: await dispatch.result };
  throwIfAborted(ctx.signal);
  return ctx;
}

export async function* executeFunction(
  tools: ToolRegistry,
  tool: FunctionToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
  snapshot?: TurnToolSnapshot,
  stages?: ToolStageSupport,
  /** Set when `tool` runs an agent tool: its trust, and its handler's failures and faults. */
  agent?: RegisteredAgentTool,
  beginBody?: (preparedInput: unknown) => Promise<ToolOperationClaim | undefined>,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const guard = resultGuard(tools, agent ?? tool, ctx, snapshot, stages?.span);
  const callId = base.callId;
  const parsed = startToolExecution(tool, rawInput, ctx);
  if (!parsed.ok) {
    return yield* settleToolFailure(guard, base, parsed.failure, stages, {
      toolName: tool.name,
      callId,
      callNotStarted: true,
    });
  }
  let input: unknown = parsed.data;

  const permissionGate = checkPermission(
    tool.name,
    tool.permission,
    ctx.sessionPermissions,
    ctx.resume,
    gateDetails(tool, input),
  );
  if (permissionGate) {
    yield* emitGateSettlement({
      base,
      gate: permissionGate,
      callId,
      toolName: tool.name,
      labels: ctx.profile.labels,
    });
    return { gated: permissionGate, callNotStarted: true };
  }

  throwIfAborted(ctx.signal);

  const settleOutcome = (outcome: ToolBodyOutcome) =>
    settleBodyOutcome({
      outcome,
      ctx,
      tool,
      base,
      callId,
      safeInput: input,
      stages,
      guard,
      labels: ctx.profile.labels,
    });
  const signedIn = yield* resolveFunctionSignIn(tool, ctx, base);
  if (signedIn.outcome) return yield* settleOutcome(signedIn.outcome);

  const preBody = yield* runFunctionPreBodyStages({ tool, input, ctx, base, stages, guard });
  if (!('ok' in preBody)) {
    return preBody;
  }
  input = preBody.input;

  if (waitsForPage(tool, ctx)) {
    // why: Last of the checks, so the page is asked only for a call every guardrail and gate let through.
    const gate: ToolGate = { kind: 'page', tool: tool.name, ...gateDetails(tool, input) };
    yield* emitGateSettlement({
      base,
      gate,
      callId,
      toolName: tool.name,
      labels: ctx.profile.labels,
    });
    return { gated: gate, callNotStarted: true };
  }

  throwIfAborted(ctx.signal);
  const handOff = yield* dispatchToolBody(tool, input, ctx, base, beginBody);
  ctx = yield* receivePageAnswer(tool, ctx, handOff, base);
  const { secret } = signedIn;
  const fail = (failure: ToolFailure) =>
    settleToolFailure(
      guard,
      base,
      secret ? failureWithoutSecret(failure, secret) : failure,
      stages,
      { toolName: tool.name, callId, input },
    );

  const checks = requestChecks(stages?.span);
  const handlerCtx: ToolContext = signedIn.prepared
    ? { ...ctx, signedInFetch: signedInFetch(signedIn.prepared, ctx, checks) }
    : ctx;
  let output: unknown;
  await handOff.claim();
  try {
    const shown = new HandlerEvents(base, guard.handlerEvents(stages?.drafts === true));
    output = yield* runHandler(tool.handler, input as never, handlerCtx, shown);
    checks.record();
  } catch (err) {
    if (err instanceof ToolFailed) return yield* fail(err.failure);
    // why: Anything but a settled failure is the host's to fix, as a compactor's is.
    if (agent) throw err;
    if (signedIn.prepared && err instanceof CredentialRefusedError) {
      checks.record();
      const refused = yield* refusedCredentialOutcome(
        tool,
        err.refusal,
        signedIn.secret !== undefined,
        ctx,
        base,
      );
      if (refused) return yield* settleOutcome(refused);
    }
    if (signedIn.prepared && errorKind(err) === 'blocked') {
      const blocked = networkBlockedEvent();
      checks.record(blocked);
      return yield* fail(yield* networkBlocked(err, blocked));
    }
    return yield* fail(functionHandlerFailure(err));
  }
  if (secret) output = omitSecret(output, secret);
  if (output === undefined) {
    return yield* fail({
      code: 'invalid_output',
      kind: 'bad_response',
      message: labelText('tool.handler_no_output', {}, ctx.profile.labels),
    });
  }
  const checked = checkOutput(tool, output);
  if (!checked.success) {
    return yield* fail({
      code: 'invalid_output',
      kind: 'bad_response',
      message: labelText('tool.output_invalid', {}, ctx.profile.labels),
      details: schemaIssueDetails(checked.error.issues),
    });
  }
  const promoted = applyT2LoaderPromotion(tools, tool, checked.data, ctx, snapshot);
  if (!promoted.ok) {
    return yield* fail(promoted.failure);
  }

  // why: The T2 loader's output drives the snapshot, so the host may not mutate it.
  const ownsOutput = loadsT2(tool, ctx);
  return yield* settleToolCall({
    base,
    toolName: tool.name,
    callId,
    input,
    stages,
    guard,
    provisional: {
      outputRaw: promoted.output,
      modelResult: projectForModel(tool, promoted.output, ctx.profile.labels),
    },
    sources: tool.sources,
    labels: tool.labels,
    ...forModelOf(tool),
    ...(ownsOutput
      ? {}
      : {
          reproject: makeReproject(
            (v) => checkOutput(tool, v),
            (data) => projectForModel(tool, data, ctx.profile.labels),
            ctx.profile.labels,
          ),
        }),
  });
}

/** Names the profile's loader when it can load the tool, so the model knows which call comes first. */
export function notLoadedMessage(
  tool: { name: string; loadTier?: string },
  profile: Profile,
): string {
  const loader = profileToolsSpec(profile)?.t2Loader;
  if (tool.loadTier === 'T2' && loader) {
    return labelText('tool.not_loaded_t2', { tool: tool.name, loader }, profile.labels);
  }
  return labelText('tool.not_visible', { tool: tool.name }, profile.labels);
}

function earlyFailure(failure: ToolFailure): ToolExecuteSettlement {
  return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
}

export async function* executeBuiltin(
  tool: { name: string },
  ctx: ToolContext,
  base: ToolCallBase,
  snapshot: TurnToolSnapshot,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  yield toolEvent(base, { phase: 'running' });
  throwIfAborted(ctx.signal);
  if (!snapshot.builtins.includes(tool.name)) {
    const failure: ToolFailure = {
      code: 'not_loaded',
      kind: 'request',
      message: labelText('tool.builtin_not_enabled', { tool: tool.name }, ctx.profile.labels),
    };
    yield failureEvent(base, failure);
    return earlyFailure(failure);
  }
  const failure: ToolFailure = {
    code: 'provider_native',
    kind: 'request',
    message: labelText('tool.provider_native', { tool: tool.name }, ctx.profile.labels),
  };
  yield failureEvent(base, failure);
  return earlyFailure(failure);
}

function registeredEligibilityFailure(args: {
  tool: RegisteredTool;
  profile: Profile;
  name: string;
  resume: ToolContext['resume'];
  snapshot?: TurnToolSnapshot;
  /** The tools visible when the call's step began; a tool loaded later in the step is not among them. */
  visible?: readonly ToolId[];
}): ToolFailure | undefined {
  const { tool, profile, name, resume, snapshot } = args;
  if (!profileToolAllow(profile).includes(name)) {
    return {
      code: 'not_allowed',
      kind: 'blocked',
      message: labelText('tool.not_allowed', { tool: name, profile: profile.id }, profile.labels),
    };
  }
  if (!snapshot) return undefined;
  const continuing = isResumeContinuation(resume);
  if (!continuing && !snapshot.gated.includes(name)) {
    return {
      code: 'not_gated',
      kind: 'request',
      message: labelText('tool.not_eligible', { tool: name }, profile.labels),
    };
  }
  if (!(args.visible ?? snapshot.visible).includes(name)) {
    const skipLoadCheck = continuing && tool.loadTier === 'T0';
    if (!skipLoadCheck) {
      return {
        code: 'not_loaded',
        kind: 'request',
        message: notLoadedMessage(tool, profile),
      };
    }
  }
  return undefined;
}

/** A model's call that sets a field the input schema keeps from the model: the host fills those. */
function hostFieldsFailure(
  args: RegisteredToolCall,
  tool: { inputSchema: Record<string, unknown> },
  input: unknown,
): ToolFailure | undefined {
  if (!args.fromModel) return undefined;
  const notInputs = markedFieldsIn(tool.inputSchema, input);
  if (notInputs.length === 0) return undefined;
  return {
    code: 'invalid_input',
    kind: 'bad_response',
    message: labelText(
      'tool.input_host_fields',
      { tool: args.name, fields: notInputs.join(', ') },
      args.profile.labels,
    ),
    details: { notInputs },
  };
}

export function authorizeToolReplay(args: {
  tools: ToolRegistry;
  profile: Profile;
  name: string;
  resume: ToolContext['resume'];
  snapshot?: TurnToolSnapshot;
  outcome?: ToolOperationOutcome;
}): void {
  const tool = args.tools.get(args.name);
  if (!tool || tool.type === 'builtin') {
    throw new TheoremError('blocked', labelText('error.blocked'));
  }
  const failure = registeredEligibilityFailure({ ...args, tool });
  if (failure) throw new TheoremError(failure.kind, failure.message);
  if (args.outcome) authorizeSavedDisclosure(args, tool, args.outcome);
}

function authorizeSavedDisclosure(
  args: { tools: ToolRegistry; profile: Profile; snapshot?: TurnToolSnapshot },
  tool: RegisteredTool,
  outcome: ToolOperationOutcome,
): void {
  const blocked = () =>
    new TheoremError('blocked', labelText('detect.output_blocked', {}, args.profile.labels));
  const result = outcome.replay.modelResult;
  if (
    tool.type === 'function' &&
    tool.exposeToModel === false &&
    result?.finding !== labelText('tool.completed_hidden', {}, args.profile.labels)
  )
    throw blocked();
  const guard = guardToolResult(
    outcome.event.tool.readBack ?? '',
    { event: outcome.event, output: outcome.replay.outputRaw },
    provenanceFor(tool, args.tools),
    resolveGuardrailPolicy(args.profile.guardrails),
    tool.type === 'builtin' ? undefined : toolBoundary('tool_output', tool.type),
    args.snapshot?.executable ?? [],
    args.profile.labels,
  );
  if (guard.event?.action === 'block' || guard.event?.action === 'redact') throw blocked();
}

/** Settles an outcome the kernel reached without a handler's own result: a remote body, or a sign-in. */
async function* settleBodyOutcome(args: {
  outcome: ToolBodyOutcome;
  tool: HttpToolDef | McpToolDef | FunctionToolDef;
  base: ToolCallBase;
  callId: string;
  safeInput: unknown;
  stages?: ToolStageSupport;
  guard: ResultGuard;
  labels: LabelOverrides | undefined;
  ctx: ToolContext;
}): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { outcome, tool, base, callId, safeInput, stages, guard, labels, ctx } = args;
  const name = tool.name;

  if (outcome.kind === 'gated') {
    if (outcome.gate.kind === 'confirmation') {
      return { gated: outcome.gate, callNotStarted: true };
    }
    const gateReadBack = yield* emitGateSettlement({
      base,
      gate: outcome.gate,
      callId,
      toolName: name,
      labels,
    });
    return { gated: outcome.gate, callNotStarted: true, ...(gateReadBack ? { gateReadBack } : {}) };
  }
  if (outcome.kind === 'aborted') {
    return { aborted: outcome.aborted, callNotStarted: true };
  }
  if (outcome.kind === 'failed') {
    return yield* settleToolFailure(guard, base, outcome.failure, stages, {
      toolName: name,
      callId,
      input: safeInput,
      callNotStarted: outcome.callNotStarted,
      ...(outcome.denied ? { denied: true } : {}),
    });
  }
  return yield* settleToolCall({
    base,
    toolName: name,
    callId,
    input: safeInput,
    stages,
    guard,
    provisional: { outputRaw: outcome.outputRaw, modelResult: outcome.modelResult },
    sources: tool.sources,
    ...forModelOf(tool),
    ...(tool.type !== 'function' && tool.media
      ? {
          media: (output: unknown) =>
            fetchToolMedia(tool.media as never, output, ctx, tool.imageLimits),
        }
      : {}),
    labels: tool.labels,
    reproject: makeReproject(
      (v) => parseToolOutput(tool.output, v),
      // why: A hook's edit replaces the value; the media the tool returned stays.
      (data) =>
        withMedia(modelResultFromOutput(data, tool.outputSchema), outcome.modelResult.media),
      labels,
    ),
  });
}

interface RegisteredToolCall {
  execution?: ToolExecutionCoordinator;
  background?: ToolBackgroundSupport;
  invocation?: unknown;
  onDispatch?: () => void;
  beginBody?: (preparedInput: unknown) => Promise<ToolOperationClaim | undefined>;
  tools: ToolRegistry;
  profile: Profile;
  name: string;
  input: unknown;
  callId: string;
  ctx: Omit<ToolContext, 'callId' | 'profile' | 'operationId'> & { operationId?: string };
  snapshot?: TurnToolSnapshot;
  stages?: ToolStageSupport;
  /** Omitted: the call is not traced. The span is handed to the tool as `ctx.traceparent`. */
  openSpan?: (name: string, attributes: TraceAttributes) => SpanHandle;
  /** Defaults to `turnReadBack`; a transport that sends something else (Live's `functionResponse`) passes its own. */
  readBack?: (settlement: ToolExecuteSettlement) => ToolCallEnd['result'];
  /** Runs agent tool calls; without it an agent tool fails as a type the transport can't run. */
  agents?: AgentCaller;
  /** The canary and system instruction of the turn the model called from, read for in the arguments. */
  scope?: DetectScope;
  /** The model made the call: a field its input schema keeps from the model is refused. */
  fromModel?: boolean;
}

function turnReadBack({ modelResult }: ToolExecuteSettlement): ToolCallEnd['result'] {
  return modelResult
    ? { text: formatToolResult(modelResult), parts: modelResult.parts }
    : undefined;
}

/** The service a sign-in gate's answer names, from the tool's own auth config. */
function signInService(tool: RegisteredTool, resume: ToolContext['resume']) {
  if (!resume?.signIn || tool.type === 'builtin' || tool.type === 'agent') return undefined;
  return tool.auth?.service;
}

/**
 * A gate nobody answered: a sign-in for `expiredService` whose link expired, or any other gate
 * left behind. Both settle as `cancelled`.
 */
export function lapsedGateFailure(
  toolName: string,
  expiredService: string | undefined,
  labels: LabelOverrides | undefined,
): ToolFailure {
  if (expiredService) {
    return {
      code: 'expired',
      kind: 'cancelled',
      message: labelText('sign_in.expired', { service: expiredService }, labels),
    };
  }
  return {
    code: 'cancelled',
    kind: 'cancelled',
    message: labelText('session.abandon_gated', { tool: toolName }, labels),
  };
}

/** `abandoned` and `expired` settle as `cancelled`. */
function refusalFailure(
  tool: RegisteredTool,
  resume: ToolContext['resume'],
  labels: LabelOverrides | undefined,
): ToolFailure {
  const service = signInService(tool, resume);
  const cause = resume?.cause ?? 'declined';
  if (cause === 'declined') {
    return {
      code: 'denied',
      kind: 'declined',
      message: service
        ? labelText('sign_in.declined', { service }, labels)
        : labelText('session.tool_denied', { tool: tool.name }, labels),
    };
  }
  return lapsedGateFailure(tool.name, cause === 'expired' ? service : undefined, labels);
}

function resumeApproval(resume: ToolContext['resume']): boolean | undefined {
  if (isGateResumeGranted(resume)) return true;
  if (isGateResumeDenied(resume)) return false;
  return undefined;
}

function toolCallEnd(
  settlement: ToolExecuteSettlement,
  readBack: NonNullable<RegisteredToolCall['readBack']>,
): ToolCallEnd {
  const { failure } = settlement;
  const result = readBack(settlement);
  const outcome: ToolOutcome = settlement.gated
    ? 'gated'
    : settlement.aborted !== undefined && settlement.callNotStarted
      ? 'cancelled'
      : settlement.denied
        ? 'denied'
        : failure
          ? 'error'
          : settlement.awaiting
            ? 'paused'
            : 'ok';
  return {
    outcome,
    ...(result ? { result } : {}),
    ...(!failure && 'outputRaw' in settlement ? { data: { value: settlement.outputRaw } } : {}),
    ...(failure ? { failure } : {}),
  };
}

/** Runs one registered tool call as a stream of turn events and returns how it settled; when `openSpan` is given the call is recorded as a tool span that ends with the outcome. */
/**
 * A call's arguments as its tool gets them, which is what the call's first
 * event shows the host: a detector's placeholder where it redacts, and none
 * when the call is stopped. A call no tool takes is read as a function tool's.
 */
export function shownToolArguments(
  call: Pick<RegisteredToolCall, 'tools' | 'profile' | 'name' | 'input' | 'scope'>,
): Record<string, unknown> {
  const tool = call.tools.get(call.name);
  const policy = resolveGuardrailPolicy(call.profile.guardrails);
  const inspected = inspectToolArguments(
    plainToolInput(call.input),
    tool ? provenanceFor(tool, call.tools) : { origin: 'local', tool: call.name, depth: 1 },
    policy,
    toolArgumentsBoundary(call.tools, call.name),
    scopeOf(policy, call.scope ?? {}),
  );
  const { args } = inspected;
  return args !== null && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

export async function* executeRegisteredTool(
  args: RegisteredToolCall,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  args = {
    ...args,
    ctx: { ...args.ctx, operationId: args.ctx.operationId ?? crypto.randomUUID() },
  };
  const operationId = args.ctx.operationId ?? crypto.randomUUID();
  const detach = planDetach({
    tool: args.tools.get(args.name),
    input: args.input,
    support: args.background,
    base: { name: args.name, callId: args.callId, operationId },
    agents: args.agents,
    labels: args.profile.labels,
  });
  return yield* coordinateTool(
    args.execution,
    {
      operationId,
      callId: args.callId,
      profileId: args.profile.id,
      toolId: args.name,
    },
    {
      input: args.input,
      resume: args.ctx.resume,
      snapshot: args.snapshot,
      context: args.invocation,
    },
    args.ctx.signal,
    (beginBody, hooks) =>
      executeTracedTool({
        ...args,
        ...(detach ? { openSpan: detach.trace.open } : {}),
        ctx: { ...args.ctx, signal: hooks.signal },
        ...(args.stages ? { stages: { ...args.stages, ...hooks } } : {}),
        beginBody: async (input) => {
          const claim = (await beginBody?.(input)) ?? (await args.beginBody?.(input));
          args.onDispatch?.();
          return claim;
        },
      }),
    (outcome) =>
      authorizeToolReplay({
        outcome,
        tools: args.tools,
        profile: args.profile,
        name: args.name,
        resume: args.ctx.resume,
        snapshot: args.snapshot,
      }),
    { detach, labels: args.profile.labels },
  );
}

async function* executeTracedTool(
  args: RegisteredToolCall,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const tool = args.tools.get(args.name);
  if (!args.openSpan) {
    return yield* runRegisteredTool(args, tool);
  }
  const trace = startToolTrace(args.openSpan, {
    name: args.name,
    callId: args.callId,
    call: { arguments: toolCallArguments(plainToolInput(args.input)) },
    origin: tool ? originOfTool(tool, args.tools) : undefined,
    permission: tool && 'permission' in tool ? tool.permission : undefined,
    approved: resumeApproval(args.ctx.resume),
    step: args.ctx.turn?.step,
  });
  const exec = runRegisteredTool(
    {
      ...args,
      ctx: { ...args.ctx, traceparent: trace.span.traceparent() },
      ...(args.stages ? { stages: { ...args.stages, span: trace.span } } : {}),
    },
    tool,
  );
  try {
    for (;;) {
      const next = await exec.next();
      if (next.done) {
        trace.end(toolCallEnd(next.value, args.readBack ?? turnReadBack));
        return next.value;
      }
      trace.observe(next.value);
      yield next.value;
    }
  } catch (err) {
    trace.end(isAbortError(err) ? { outcome: 'cancelled' } : { outcome: 'error', thrown: err });
    throw err;
  } finally {
    // why: The host stopped reading mid-call.
    if (!trace.span.ended) {
      trace.end({ outcome: 'cancelled' });
      await exec.return({});
    }
  }
}

async function* runRegisteredTool(
  args: RegisteredToolCall,
  tool: RegisteredTool | undefined,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { profile, name, callId, ctx, snapshot, stages } = args;
  const { input } = splitBackground(tool?.type === 'builtin' ? undefined : tool, args.input);
  const safeInput = plainToolInput(input);
  const operationId = ctx.operationId ?? crypto.randomUUID();
  const base = {
    name,
    callId,
    operationId,
    activityFailed: failedActivity(name, profile.labels, tool?.labels, safeInput),
  };
  if (!tool) {
    const failure: ToolFailure = {
      code: 'unknown_tool',
      kind: 'request',
      message: labelText('tool.not_registered', { tool: name }, profile.labels),
    };
    yield failureEvent(base, failure);
    return earlyFailure(failure);
  }
  if (tool.type === 'builtin') {
    if (!snapshot) {
      const failure: ToolFailure = {
        code: 'provider_native',
        kind: 'request',
        message: labelText('tool.builtin_needs_snapshot', { tool: name }, profile.labels),
      };
      yield failureEvent(base, failure);
      return earlyFailure(failure);
    }
    const fullCtx: ToolContext = { ...ctx, callId, profile, operationId };
    return yield* executeBuiltin(tool, fullCtx, base, snapshot);
  }

  const eligibility =
    registeredEligibilityFailure({
      tool,
      profile,
      name,
      resume: ctx.resume,
      snapshot,
      visible: ctx.turn?.visible,
    }) ?? hostFieldsFailure(args, tool, safeInput);
  if (eligibility) {
    yield failureEvent(base, eligibility);
    return earlyFailure(eligibility);
  }

  if (isGateResumeDenied(ctx.resume)) {
    return yield* settleToolFailure(
      resultGuard(
        args.tools,
        tool,
        { ...ctx, callId, profile, operationId },
        snapshot,
        stages?.span,
      ),
      base,
      refusalFailure(tool, ctx.resume, profile.labels),
      stages,
      { toolName: name, callId, input: safeInput, callNotStarted: true, denied: true },
    );
  }

  const fullCtx: ToolContext = { ...ctx, callId, profile, operationId };
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const provenance = provenanceFor(tool, args.tools);

  const argsStart = performance.now();
  const kind = toolKindOf(tool);
  const inspected = inspectToolArguments(
    safeInput,
    provenance,
    policy,
    kind && toolBoundary('tool_arguments', kind),
    scopeOf(policy, args.scope ?? {}),
  );
  recordToolCheck(stages?.span, 'tool_arguments', performance.now() - argsStart, inspected.event);
  if (inspected.event) {
    yield { type: 'guardrail', guardrail: inspected.event };
  }
  if (!('args' in inspected)) {
    const failure: ToolFailure = {
      code: 'arguments_blocked',
      kind: 'blocked',
      message: labelText('detect.call_blocked', {}, profile.labels),
    };
    yield failureEvent(base, failure);
    return { ...earlyFailure(failure), denied: true };
  }

  const taintStart = performance.now();
  const taintVerdict = checkTaintGate(ctx.turn?.taint, tool.access, policy, profile.labels);
  const taintEvent = toolCallEvent(taintVerdict, provenance);
  recordToolCheck(stages?.span, 'taint', performance.now() - taintStart, taintEvent);
  if (taintEvent) {
    yield { type: 'guardrail', guardrail: taintEvent };
  }
  if (taintVerdict.action === 'block') {
    const failure: ToolFailure = {
      code: 'tainted_turn',
      kind: 'blocked',
      message: taintVerdict.rejection,
    };
    yield failureEvent(base, failure);
    return { ...earlyFailure(failure), denied: true };
  }

  const stopped = yield* settleRemoteDestination({
    tool,
    input: inspected.args,
    ctx: fullCtx,
    base,
    provenance,
    policy,
    span: stages?.span,
  });
  if (stopped) return stopped;

  return yield* settleByType(
    args.tools,
    tool,
    inspected.args,
    fullCtx,
    base,
    snapshot,
    stages,
    args.agents,
    args.beginBody,
  );
}

/** The call's settlement when a destination in its arguments stops it: refused, or held for the user's answer. */
async function* settleRemoteDestination(args: {
  tool: Parameters<typeof gateDetails>[0] & { name: string };
  input: unknown;
  ctx: ToolContext;
  base: ToolCallBase;
  provenance: Provenance;
  policy: ResolvedGuardrailPolicy;
  span: ToolStageSupport['span'];
}): AsyncGenerator<TurnEvent, ToolExecuteSettlement | undefined> {
  const { tool, input, ctx, base } = args;
  const { labels } = ctx.profile;
  const start = performance.now();
  const { verdict, confirm } = checkDestinationGate(
    ctx.turn?.destinations,
    input,
    args.policy,
    labels,
  );
  const event = toolCallEvent(verdict, args.provenance);
  recordToolCheck(args.span, 'destination', performance.now() - start, event);
  if (event) {
    yield { type: 'guardrail', guardrail: event };
  }
  if (verdict.action === 'block') {
    const failure: ToolFailure = {
      code: 'remote_destination',
      kind: 'blocked',
      message: verdict.rejection,
    };
    yield failureEvent(base, failure);
    return { ...earlyFailure(failure), denied: true };
  }
  if (!confirm || isGateResumeGranted(ctx.resume)) return undefined;
  const gate: ToolGate = {
    kind: 'confirmation',
    tool: tool.name,
    summary: confirm,
    ...gateDetails(tool, input),
  };
  yield* emitGateSettlement({
    base,
    gate,
    callId: ctx.callId,
    toolName: tool.name,
    labels,
  });
  return { gated: gate, callNotStarted: true };
}

/**
 * An agent tool runs as a function tool whose handler is the called agent's
 * turn, so input checks, gates, stages, and the result guard are the same. The
 * agent's reply streams as the call's drafts and its other events as its
 * `progress`, and its usage rides on the call's last phase.
 */
async function* executeAgentTool(args: {
  tools: ToolRegistry;
  tool: RegisteredAgentTool;
  safeInput: unknown;
  ctx: ToolContext;
  base: ToolCallBase;
  snapshot: TurnToolSnapshot | undefined;
  stages: ToolStageSupport | undefined;
  agents: AgentCaller | undefined;
  beginBody?: (preparedInput: unknown) => Promise<ToolOperationClaim | undefined>;
}): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { tool, ctx, base, agents } = args;
  if (!agents) {
    const failure: ToolFailure = {
      code: 'unknown_tool',
      kind: 'unsupported',
      message: labelText('tool.unsupported_type', { tool: tool.name }, ctx.profile.labels),
    };
    yield failureEvent(base, failure);
    return earlyFailure(failure);
  }
  let tokens: TurnTokens | undefined;
  const span = args.stages?.span;
  // why: A hook's crash goes to the host as its own event, never inside the call's progress.
  const crashes: TurnEvent[] = [];
  const handler = async function* (
    input: unknown,
    handlerCtx: ToolContext,
  ): AsyncGenerator<ToolStreamEvent<AgentToolOutput>> {
    const run = agents.run({
      tool,
      callId: handlerCtx.callId,
      // why: Checked against the tool's input schema before the handler runs.
      input: input as AgentToolInput,
      caller: handlerCtx.profile,
      ...(span ? { span } : {}),
      ...(handlerCtx.signal ? { signal: handlerCtx.signal } : {}),
      ...(args.stages?.steers ? { steers: args.stages.steers } : {}),
    });
    // why: A retry throws away the reply drafted so far; the drafts stop there, and the output arrives whole.
    let retried = false;
    const seen: TurnEvent[] = [];
    for (;;) {
      const next = await run.next();
      if (next.done) {
        tokens = next.value.tokens;
        if ('failure' in next.value) throw new ToolFailed(next.value.failure);
        yield { kind: 'complete', output: next.value.output };
        return;
      }
      const event = next.value;
      if (event.type === 'hook_failed') {
        crashes.push(event);
        continue;
      }
      if (event.type === 'tokens' || event.type === 'tool') {
        seen.push(event);
        const spent = sumTurnTokens(seen);
        // why: A stopped agent throws before it returns its usage.
        if (spent) args.stages?.spent?.(spent);
      }
      if (event.type === 'attempt') retried = true;
      if (event.type === 'text' || event.type === 'structured_draft') {
        if (!retried) yield { kind: 'draft', text: event.text };
        continue;
      }
      yield { kind: 'progress', data: { agent: tool.profile, event } };
    }
  };
  // why: Its hooks take `AgentToolInput`, which the input schema has already checked.
  const outputSchema = agentOutputSchema(
    tool.outputSchema,
    args.tools.structuredReplies(tool.profile),
  );
  const asFunction = { ...tool, type: 'function', handler, outputSchema } as FunctionToolDef;
  const exec = executeFunction(
    args.tools,
    asFunction,
    args.safeInput,
    ctx,
    base,
    args.snapshot,
    args.stages,
    tool,
    args.beginBody,
  );
  for (;;) {
    const next = await exec.next();
    yield* crashes.splice(0);
    if (next.done) return next.value;
    yield withAgentTokens(next.value, base.callId, tokens);
  }
}

/** The called agent's usage on the call's `complete` or `error` phase. */
function withAgentTokens(
  event: TurnEvent,
  callId: string,
  tokens: TurnTokens | undefined,
): TurnEvent {
  if (!tokens || event.type !== 'tool' || event.tool.callId !== callId) return event;
  const { tool } = event;
  if (tool.phase !== 'complete' && tool.phase !== 'error') return event;
  return { ...event, tool: { ...tool, tokens } };
}

async function* settleByType(
  tools: ToolRegistry,
  tool: RegisteredTool,
  safeInput: unknown,
  fullCtx: ToolContext,
  base: ToolCallBase,
  snapshot: TurnToolSnapshot | undefined,
  stages: ToolStageSupport | undefined,
  agents: AgentCaller | undefined,
  beginBody?: (preparedInput: unknown) => Promise<ToolOperationClaim | undefined>,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { name } = tool;
  if (tool.type === 'function') {
    return yield* executeFunction(
      tools,
      tool,
      safeInput,
      fullCtx,
      base,
      snapshot,
      stages,
      undefined,
      beginBody,
    );
  }
  if (tool.type === 'agent') {
    return yield* executeAgentTool({
      tools,
      tool,
      safeInput,
      ctx: fullCtx,
      base,
      snapshot,
      stages,
      agents,
      beginBody,
    });
  }

  if (tool.type !== 'http' && tool.type !== 'mcp') {
    return earlyFailure({
      code: 'unknown_tool',
      kind: 'request',
      message: labelText('tool.unsupported_type', { tool: name }, fullCtx.profile.labels),
    });
  }
  const guard = resultGuard(tools, tool, fullCtx, snapshot, stages?.span);
  const body: ToolBodyOutcome =
    tool.type === 'http'
      ? yield* executeHttpTool(
          tool,
          safeInput,
          fullCtx,
          base,
          stages,
          beginBody,
          new HandlerEvents(base, guard.handlerEvents(stages?.drafts === true)),
        )
      : yield* executeMcpTool(tool, safeInput, fullCtx, base, stages, tools.mcpSessions, beginBody);
  return yield* settleBodyOutcome({
    outcome: body,
    ctx: fullCtx,
    tool,
    base,
    callId: base.callId,
    safeInput,
    stages,
    guard,
    labels: fullCtx.profile.labels,
  });
}

/** Every tool returns through here, so a new tool type cannot skip the fence, detection, or provenance label. */
interface GuardInputs {
  provenance: Provenance;
  policy: ReturnType<typeof resolveGuardrailPolicy>;
  /** Absent for a provider builtin, whose text crosses no boundary. */
  kind: ToolKind | undefined;
  callableTools: readonly string[];
  labels: LabelOverrides | undefined;
  span: SpanHandle | undefined;
}

/**
 * A remote server writes its own error strings, so a failure's message is read
 * at `tool_failure_<kind>` before the kernel frames it for the model as a system
 * report. A blocked message is replaced by the labels' words. Its details are
 * the tool's too, so they are read at the same boundary as a result's data is;
 * blocked details settle the call as `output_blocked`. The frame is the kernel's
 * own text and is not read again.
 */
function* guardFailure(
  failure: ToolFailure,
  guard: GuardInputs,
): Generator<TurnEvent, GuardedResult> {
  const start = performance.now();
  const boundary = guard.kind && toolBoundary('tool_failure', guard.kind);
  const checked = guardToolFailureText(failure.message, guard.provenance, guard.policy, boundary);
  recordToolCheck(guard.span, 'tool_failure', performance.now() - start, checked.event);
  if (checked.event) {
    yield { type: 'guardrail', guardrail: checked.event };
  }
  const message = checked.text ?? labelText('detect.output_blocked', {}, guard.labels);
  const framed = frameToolFailure({ ...failure, message });
  const read = yield* readBack(framed, guard, boundary, checked.suspicious, 'data');
  if (read) return { modelResult: read };
  const withheld = blockedOutput(guard);
  return { modelResult: yield* reportFailure(withheld, guard, checked.suspicious), withheld };
}

/** The failure a call settles as when the guard blocks what the model would read of it. */
function blockedOutput(guard: GuardInputs): ToolFailure {
  return {
    code: 'output_blocked',
    kind: 'blocked',
    message: labelText('detect.output_blocked', {}, guard.labels),
  };
}

/**
 * A failure framed for the model in the kernel's own words, fenced and labelled like any result.
 * `suspicious` is what `injection` found in a remote failure's message, which raises taint as a
 * result's does.
 */
function* reportFailure(
  failure: ToolFailure,
  guard: GuardInputs,
  suspicious?: GuardrailHit[],
): Generator<TurnEvent, ModelToolResult> {
  const framed = frameToolFailure(failure);
  return (yield* readBack(framed, guard, undefined, suspicious)) ?? framed;
}

/** A result read at `tool_output_<kind>`. A blocked one settles as a failed call the model is told about. */
function* guardResult(
  result: ModelToolResult,
  guard: GuardInputs,
): Generator<TurnEvent, GuardedResult> {
  const boundary = guard.kind && toolBoundary('tool_output', guard.kind);
  const texts = yield* readTextParts(result, guard, boundary);
  const read = texts && (yield* readBack(texts, guard, boundary));
  if (read) return { modelResult: read };
  const withheld = blockedOutput(guard);
  return { modelResult: yield* reportFailure(withheld, guard), withheld };
}

/**
 * `result` with the text parts the model reads beside its read-back read at `boundary`, each
 * match set to `redact` replaced; `undefined` when a match blocks them.
 */
function* readTextParts(
  result: ModelToolResult,
  guard: GuardInputs,
  boundary: ToolBoundary | undefined,
): Generator<TurnEvent, ModelToolResult | undefined> {
  const media = result.media;
  const texts = media?.map(partText) ?? [];
  if (!media || texts.every((text) => text === null)) return result;
  const read = guardToolValue(texts, guard.provenance, guard.policy, boundary, {
    callable: guard.callableTools,
  });
  if (read.event) yield { type: 'guardrail', guardrail: read.event };
  if (!('value' in read)) return undefined;
  const kept = keptTexts.safeParse(read.value);
  if (!kept.success || kept.data.length !== media.length) {
    throw new TheoremError('internal', 'A guard changed the shape of the text parts it read'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const { media: _media, parts: _parts, ...rest } = result;
  return withMedia(
    rest,
    media.map((part, index) => {
      const text = kept.data[index];
      if (typeof text !== 'string') return part;
      return part.type === 'text' ? { ...part, text } : { ...part, data: textFileData(text) };
    }),
  );
}

/** The text the detectors read in a part: a text part's words, or a text file's decoded bytes. */
function partText(part: ToolOutputPart): string | null {
  if (part.type === 'text') return part.text;
  return 'data' in part && isTextFile(part.mimeType)
    ? textFileText(part.mimeType, part.data)
    : null;
}

const keptTexts = z.array(z.string().nullable());

/** The parts the person is shown, each read at `tool_shown_<kind>` with a text file's bytes decoded; a blocked one is left out. */
function* showParts(
  parts: readonly ToolOutputPart[],
  guard: GuardInputs,
): Generator<TurnEvent, ToolOutputPart[]> {
  const boundary = guard.kind && toolBoundary('tool_shown', guard.kind);
  const shown: ToolOutputPart[] = [];
  for (const part of parts) {
    // why: a text file's bytes are read decoded; other bytes are not text the detectors read. Every other field of the part is read as it is shown.
    const { data, ...fields } = 'data' in part ? part : { ...part, data: undefined };
    const text = data === undefined ? null : partText(part);
    const read = text === null ? fields : { ...fields, data: text };
    const checked = guardToolValue(read, guard.provenance, guard.policy, boundary);
    if (checked.event) yield { type: 'guardrail', guardrail: checked.event };
    if (!('value' in checked)) continue;
    const kept = toolOutputPartRecord.safeParse(
      data === undefined || !isRecord(checked.value)
        ? checked.value
        : { ...checked.value, data: shownData(checked.value.data, text, data) },
    );
    if (!kept.success) {
      throw new TheoremError('internal', 'A guard changed the shape of a part it read'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    shown.push(kept.data);
  }
  return shown;
}

/** The output with each text file in its `parts` decoded, so the person's view of it is read as its parts are. */
function withFileTexts(output: unknown): unknown {
  if (!isRecord(output) || !Array.isArray(output.parts)) return output;
  return {
    ...output,
    parts: output.parts.map((part) => {
      const text = isFilePart(part) ? partText(part) : null;
      return text === null ? part : { ...part, data: text };
    }),
  };
}

/** The read output with each text file's text encoded again, at the parts `output` held as files. */
function shownFiles(read: unknown, output: unknown): unknown {
  if (!isRecord(read) || !Array.isArray(read.parts) || !isRecord(output)) return read;
  const given = Array.isArray(output.parts) ? output.parts : [];
  return {
    ...read,
    parts: read.parts.map((part, index) => {
      const file = given[index];
      if (!isFilePart(file) || partText(file) === null || !isRecord(part)) return part;
      return typeof part.data === 'string' ? { ...part, data: textFileData(part.data) } : part;
    }),
  };
}

/** Whether `value` is a part that carries bytes. */
function isFilePart(value: unknown): value is ToolOutputPart & { data: string; mimeType: string } {
  return (
    isRecord(value) &&
    value.type !== 'text' &&
    typeof value.data === 'string' &&
    typeof value.mimeType === 'string'
  );
}

/** A shown part's bytes after its read: a text file's read text encoded again, any other part's bytes as they were. */
function shownData(read: unknown, text: string | null, data: string): unknown {
  return text === null ? data : typeof read === 'string' ? textFileData(read) : read;
}

/** What the person is shown of `value`, read at `tool_shown_<kind>`; a blocked one is the labels' words. */
function* showValue(value: unknown, guard: GuardInputs): Generator<TurnEvent, unknown> {
  const boundary = guard.kind && toolBoundary('tool_shown', guard.kind);
  const shown = guardToolValue(value, guard.provenance, guard.policy, boundary);
  if (shown.event) yield { type: 'guardrail', guardrail: shown.event };
  return 'value' in shown ? shown.value : labelText('detect.shown_blocked', {}, guard.labels);
}

/** What the model reads of `result`, or `undefined` when a match at `boundary` blocks it. */
function* readBack(
  result: ModelToolResult,
  guard: GuardInputs,
  boundary: ToolBoundary | undefined,
  carried?: GuardrailHit[],
  read?: 'data',
): Generator<TurnEvent, ModelToolResult | undefined> {
  const { provenance, span } = guard;
  const start = performance.now();
  const guarded = guardToolResult(
    result.finding,
    result.data,
    provenance,
    guard.policy,
    boundary,
    guard.callableTools,
    guard.labels,
    carried,
    read,
  );
  recordToolCheck(span, 'tool_result', performance.now() - start, guarded.event);
  if (guarded.event) {
    yield { type: 'guardrail', guardrail: guarded.event };
  }
  if (guarded.text === undefined) return undefined;
  return {
    ...result,
    modelText: guarded.text,
    provenance,
    ...(guarded.suspicious ? { suspicious: guarded.suspicious } : {}),
  };
}

export type { RegisteredToolCall, ToolStageSupport };
export { startToolExecution };
