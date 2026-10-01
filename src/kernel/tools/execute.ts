import { errorKind, isAbortError, throwIfAborted } from '../../guardrails/error.ts';
import { type LexiconOverrides, lexiconText } from '../../guardrails/lexicon.ts';
import { resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import {
  checkTaintGate,
  guardToolFailureText,
  guardToolResult,
  inspectToolArguments,
  toolCallEvent,
} from '../../guardrails/tool-result.ts';
import type { Provenance, ToolOrigin } from '../../guardrails/types.ts';
import type { SpanHandle, TraceAttributes } from '../../observability/trace-span.ts';
import {
  recordToolCheck,
  startToolTrace,
  type ToolCallEnd,
  type ToolOutcome,
} from '../engine/tool-trace.ts';
import { type InjectUnit, isAwaitingUserInput } from '../stages.ts';
import type { Source } from '../turn-events.ts';
import type { InteractionPart, Profile, TurnEvent } from '../types.ts';
import { isRecord } from '../util/record.ts';
import { fillActivityLabel } from './activity-label.ts';
import {
  failureEvent,
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
import { formatToolFailureForModel, formatToolResult } from './model-text.ts';
import {
  checkPermission,
  isGateResumeDenied,
  isGateResumeGranted,
  isResumeContinuation,
} from './permission.ts';
import type { ToolRegistry } from './registry.ts';
import {
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
  FunctionToolDef,
  HttpToolDef,
  McpToolDef,
  ModelToolResult,
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

function originOfTool(type: RegisteredTool['type']): ToolOrigin {
  if (type === 'http') return 'http';
  if (type === 'mcp') return 'mcp';
  if (type === 'builtin') return 'builtin';
  return 'local';
}

function provenanceFor(tool: RegisteredTool, depth = 1): Provenance {
  return { origin: originOfTool(tool.type), tool: tool.name, depth };
}

function isStreamHandler(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    Object.prototype.toString.call(handler) === '[object AsyncGeneratorFunction]'
  );
}

const MEDIA_PART_TYPES = new Set(['image', 'audio', 'video', 'document']);

/** Invalid entries are dropped. */
export function coerceToolResultParts(raw: unknown): InteractionPart[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const parts: InteractionPart[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push({ type: 'text', text: item.text });
      continue;
    }
    if (
      MEDIA_PART_TYPES.has(item.type) &&
      typeof item.mimeType === 'string' &&
      item.mimeType.trim() &&
      typeof item.data === 'string' &&
      item.data.length > 0
    ) {
      parts.push({
        type: item.type as 'image' | 'audio' | 'video' | 'document',
        mimeType: item.mimeType,
        data: item.data,
      });
    }
  }
  return parts.length > 0 ? parts : undefined;
}

export function leanToolResultData(output: unknown): unknown {
  if (!isRecord(output)) return output;
  const { parts: _parts, ...rest } = output;
  return rest;
}

export function* yieldHandlerSideEvent(
  base: ToolCallBase,
  event: Exclude<ToolStreamEvent, { kind: 'complete' }>,
): Generator<TurnEvent> {
  if (event.kind === 'progress') {
    yield toolEvent(base, { phase: 'progress', data: event.data });
  } else if (event.kind === 'trace') {
    yield toolEvent(base, { phase: 'trace', step: event.step });
  } else if (event.kind === 'artifact') {
    yield toolEvent(base, { phase: 'artifact', artifact: event.artifact });
  } else if (event.kind === 'warning') {
    yield toolEvent(base, { phase: 'warning', warning: event.warning });
  }
}

async function* runHandler<TIn, TOut>(
  handler: FunctionToolDef<TIn, TOut>['handler'],
  input: TIn,
  ctx: ToolContext,
  base: ToolCallBase,
): AsyncGenerator<TurnEvent, TOut | undefined> {
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
      yield* yieldHandlerSideEvent(base, event);
    }
    return output;
  }
  const output = await (handler as (input: TIn, ctx: ToolContext) => TOut | Promise<TOut>)(
    input,
    ctx,
  );
  return output;
}

export function projectForModel(
  tool: FunctionToolDef,
  output: unknown,
  lexicon?: LexiconOverrides,
): ModelToolResult {
  if (tool.exposeToModel === false) {
    return { finding: lexiconText('tool.completed_hidden', {}, lexicon) };
  }
  if (isAwaitingUserInput(output)) {
    return {
      finding: lexiconText(
        'tool.awaiting_user',
        { kind: output.kind, prompt: output.prompt },
        lexicon,
      ),
      data: leanToolResultData(output),
    };
  }
  const parts =
    isRecord(output) && 'parts' in output ? coerceToolResultParts(output.parts) : undefined;
  const lean = leanToolResultData(output);
  const summarized = isRecord(lean) && 'finding' in lean;
  const { finding: summary, ...rest } = summarized ? lean : {};
  const result = summarized
    ? {
        finding: String(summary),
        ...(Object.keys(rest).length > 0 ? { data: rest } : {}),
      }
    : modelResultFromOutput(lean);
  return { ...result, ...(parts ? { parts } : {}) };
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
        message: lexiconText(
          'tool.t2_loader_needs_snapshot',
          { tool: tool.name },
          ctx.profile.lexicon,
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
        message: lexiconText('tool.t2_loader_shape', { tool: tool.name }, ctx.profile.lexicon),
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
        message: lexiconText('tool.t2_loader_output_invalid', {}, ctx.profile.lexicon),
        details: rechecked.error.flatten(),
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
};

/** Unguarded; `settleToolCall` guards the result. */
type Reproject = (
  output: unknown,
) =>
  | { ok: true; outputRaw: unknown; modelResult: ModelToolResult }
  | { ok: false; failure: ToolFailure };

/** Guards what the model reads back from a call: a result, or a failure's message and then its framing. */
interface ResultGuard {
  result: (result: ModelToolResult) => Generator<TurnEvent, ModelToolResult>;
  failure: (failure: ToolFailure) => Generator<TurnEvent, ModelToolResult>;
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
): Generator<
  TurnEvent,
  | { failure?: ToolFailure; outputRaw: unknown; modelResult: ModelToolResult; awaiting: boolean }
  | undefined
> {
  if (post.deny) {
    const failure: ToolFailure = {
      code: post.deny.code,
      kind: 'blocked',
      message: post.deny.message,
    };
    return {
      failure,
      outputRaw: undefined,
      modelResult: yield* guard.failure(failure),
      awaiting: false,
    };
  }
  if (!post.mutate || !reproject) return undefined;
  const next = reproject(plainToolInput(post.mutate.output));
  if (!next.ok) {
    return {
      failure: next.failure,
      outputRaw: undefined,
      modelResult: yield* guard.failure(next.failure),
      awaiting: false,
    };
  }
  return {
    outputRaw: next.outputRaw,
    modelResult: yield* guard.result(next.modelResult),
    awaiting: isAwaitingUserInput(next.outputRaw),
  };
}

function completeEvent(
  base: ToolCallBase,
  settled: {
    input: unknown;
    outputRaw: unknown;
    modelResult: ModelToolResult;
    labels?: ToolLabels;
  },
): TurnEvent {
  const { input, outputRaw, modelResult } = settled;
  const activityPast = fillActivityLabel(settled.labels?.activityPast, {
    input,
    output: outputRaw,
  });
  return toolEvent(base, {
    phase: 'complete',
    output: outputRaw,
    readBack: formatToolResult(modelResult),
    ...(modelResult.parts?.length ? { parts: modelResult.parts } : {}),
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
  /** Run on the output the call settles with, after any `mutate`. */
  sources?: (output: unknown) => Source[];
  labels?: ToolLabels;
}): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { base, toolName, callId, input, stages, provisional, guard, reproject, sources } = args;
  let modelResult = yield* 'failure' in provisional
    ? guard.failure(provisional.failure)
    : guard.result(provisional.modelResult);
  let failure = 'failure' in provisional ? provisional.failure : undefined;
  let outputRaw = 'outputRaw' in provisional ? provisional.outputRaw : undefined;
  const callNotStarted = 'callNotStarted' in provisional ? provisional.callNotStarted : undefined;
  let denied = 'denied' in provisional ? provisional.denied : undefined;
  let awaiting = !failure && isAwaitingUserInput(outputRaw);
  let post: PostToolStageOutcome | undefined;

  if (stages) {
    post = yield* runPostToolStages({
      stages,
      toolName,
      callId,
      input,
      callNotStarted,
      outputRaw,
      outputModel: modelResult,
      failure,
      awaiting: awaiting || undefined,
      mutable: !failure && reproject !== undefined,
    });
    const revised = yield* reviseAfterStages(post, guard, reproject);
    if (revised) {
      ({ failure, outputRaw, modelResult, awaiting } = revised);
      if (post.deny) denied = true;
    }
  }

  if (!failure && sources) yield* sourceEvents(base, sources, outputRaw);
  yield failure
    ? failureEvent(base, failure, formatToolResult(modelResult))
    : completeEvent(base, { input, outputRaw, modelResult, labels: args.labels });
  return {
    modelResult,
    ...(failure ? { failure } : { outputRaw }),
    ...(denied ? { denied } : {}),
    ...(callNotStarted ? { callNotStarted: true as const } : {}),
    ...(awaiting ? { awaiting: true as const } : {}),
    ...(post?.abort !== undefined ? { aborted: post.abort } : {}),
    ...(post?.inject.length ? { pendingInject: post.inject } : {}),
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
  tool: RegisteredTool,
  ctx: ToolContext,
  snapshot: TurnToolSnapshot | undefined,
  span: SpanHandle | undefined,
): ResultGuard {
  const provenance = provenanceFor(tool);
  const policy = resolveGuardrailPolicy(ctx.profile.guardrails);
  const callableTools = snapshot?.executable ?? [];
  const inputs = { provenance, policy, callableTools, lexicon: ctx.profile.lexicon, span };
  return {
    result: (result) => guardResult(result, inputs),
    failure: (failure) => guardFailure(failure, inputs),
  };
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
  | { success: false; error: { flatten: () => unknown } };

function makeReproject(
  parse: (value: unknown) => ParsedOutput,
  project: (data: unknown) => ModelToolResult,
  lexicon: LexiconOverrides | undefined,
): Reproject {
  return (output) => {
    const checked = parse(output);
    if (!checked.success) {
      return {
        ok: false,
        failure: {
          code: 'invalid_output',
          kind: 'bad_response',
          message: lexiconText('tool.output_invalid_after_mutate', {}, lexicon),
          details: checked.error.flatten(),
        },
      };
    }
    return { ok: true, outputRaw: checked.data, modelResult: project(checked.data) };
  };
}

type FunctionSignIn = {
  /** Set when the tool signs in and its credential resolved. */
  prepared?: { authHeaders: Record<string, string>; audience?: string };
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
      ...(resolved.audience ? { audience: resolved.audience } : {}),
    },
    ...(resolved.secret ? { secret: resolved.secret } : {}),
  };
}

export async function* executeFunction(
  tools: ToolRegistry,
  tool: FunctionToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
  snapshot?: TurnToolSnapshot,
  stages?: ToolStageSupport,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const guard = resultGuard(tool, ctx, snapshot, stages?.span);
  const callId = base.callId;
  const parsed = yield* startToolExecution(tool, rawInput, ctx, base);
  if (!parsed.ok) {
    return yield* settleToolFailure(
      guard,
      base,
      {
        code: 'invalid_input',
        kind: 'bad_response',
        message: lexiconText('tool.input_invalid', {}, ctx.profile.lexicon),
      },
      stages,
      { toolName: tool.name, callId, callNotStarted: true },
    );
  }
  let input: unknown = parsed.data;

  const permissionGate = checkPermission(
    tool.name,
    tool.permission,
    ctx.sessionPermissions,
    ctx.resume,
  );
  if (permissionGate) {
    yield* emitGateSettlement({
      base,
      gate: permissionGate,
      callId,
      toolName: tool.name,
      lexicon: ctx.profile.lexicon,
    });
    return { gated: permissionGate, callNotStarted: true };
  }

  throwIfAborted(ctx.signal);

  const settleOutcome = (outcome: ToolBodyOutcome) =>
    settleBodyOutcome({
      outcome,
      tool,
      base,
      callId,
      safeInput: input,
      stages,
      guard,
      lexicon: ctx.profile.lexicon,
    });
  const signedIn = yield* resolveFunctionSignIn(tool, ctx, base);
  if (signedIn.outcome) return yield* settleOutcome(signedIn.outcome);

  const preBody = yield* runFunctionPreBodyStages({ tool, input, ctx, base, stages, guard });
  if (!('ok' in preBody)) {
    return preBody;
  }
  input = preBody.input;

  throwIfAborted(ctx.signal);
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
  try {
    output = yield* runHandler(tool.handler, input as never, handlerCtx, base);
    checks.record();
  } catch (err) {
    if (signedIn.prepared && err instanceof CredentialRefusedError) {
      checks.record();
      const refused = yield* refusedCredentialOutcome(
        tool,
        err.refusal,
        signedIn.prepared.authHeaders,
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
    return yield* fail({ code: 'handler_error', kind: 'failed', message: messageOf(err) });
  }
  if (secret) output = omitSecret(output, secret);
  if (output === undefined) {
    return yield* fail({
      code: 'invalid_output',
      kind: 'bad_response',
      message: lexiconText('tool.handler_no_output', {}, ctx.profile.lexicon),
    });
  }
  const checked = tool.output.safeParse(output);
  if (!checked.success) {
    return yield* fail({
      code: 'invalid_output',
      kind: 'bad_response',
      message: lexiconText('tool.output_invalid', {}, ctx.profile.lexicon),
      details: checked.error.flatten(),
    });
  }
  const promoted = applyT2LoaderPromotion(tools, tool, checked.data, ctx, snapshot);
  if (!promoted.ok) {
    return yield* fail(promoted.failure);
  }

  // The T2 loader's output drives the snapshot, so the host may not mutate it.
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
      modelResult: projectForModel(tool, promoted.output, ctx.profile.lexicon),
    },
    sources: tool.sources,
    labels: tool.labels,
    ...(ownsOutput
      ? {}
      : {
          reproject: makeReproject(
            (v) => tool.output.safeParse(v),
            (data) => projectForModel(tool, data, ctx.profile.lexicon),
            ctx.profile.lexicon,
          ),
        }),
  });
}

export function notLoadedMessage(
  tool: { name: string; loadTier?: string },
  lexicon?: LexiconOverrides,
): string {
  if (tool.loadTier === 'T1') {
    return lexiconText('tool.not_wired_t1', { tool: tool.name }, lexicon);
  }
  if (tool.loadTier === 'T2') {
    return lexiconText('tool.not_loaded_t2', { tool: tool.name }, lexicon);
  }
  return lexiconText('tool.not_visible', { tool: tool.name }, lexicon);
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
      message: lexiconText('tool.builtin_not_enabled', { tool: tool.name }, ctx.profile.lexicon),
    };
    yield failureEvent(base, failure);
    return earlyFailure(failure);
  }
  const failure: ToolFailure = {
    code: 'provider_native',
    kind: 'request',
    message: lexiconText('tool.provider_native', { tool: tool.name }, ctx.profile.lexicon),
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
}): ToolFailure | undefined {
  const { tool, profile, name, resume, snapshot } = args;
  if (!profileToolAllow(profile).includes(name)) {
    return {
      code: 'not_allowed',
      kind: 'blocked',
      message: lexiconText(
        'tool.not_allowed',
        { tool: name, profile: profile.id },
        profile.lexicon,
      ),
    };
  }
  if (!snapshot) return undefined;
  const continuing = isResumeContinuation(resume);
  if (!continuing && !snapshot.gated.includes(name)) {
    return {
      code: 'not_gated',
      kind: 'request',
      message: lexiconText('tool.not_eligible', { tool: name }, profile.lexicon),
    };
  }
  if (!snapshot.visible.includes(name)) {
    const skipLoadCheck = continuing && tool.loadTier === 'T0';
    if (!skipLoadCheck) {
      return {
        code: 'not_loaded',
        kind: 'request',
        message: notLoadedMessage(tool, profile.lexicon),
      };
    }
  }
  return undefined;
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
  lexicon: LexiconOverrides | undefined;
}): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { outcome, tool, base, callId, safeInput, stages, guard, lexicon } = args;
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
      lexicon,
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
    labels: tool.labels,
    reproject: makeReproject(
      (v) => parseToolOutput(tool.output, v),
      // A hook's edit replaces the value; the media the tool returned stays.
      (data) => withMedia(modelResultFromOutput(data), outcome.modelResult.parts),
      lexicon,
    ),
  });
}

interface RegisteredToolCall {
  tools: ToolRegistry;
  profile: Profile;
  name: string;
  input: unknown;
  callId: string;
  ctx: Omit<ToolContext, 'callId' | 'profile'>;
  snapshot?: TurnToolSnapshot;
  stages?: ToolStageSupport;
  /** Omitted: the call is not traced. The span is handed to the tool as `ctx.traceparent`. */
  openSpan?: (name: string, attributes: TraceAttributes) => SpanHandle;
  /** Defaults to `turnReadBack`; a transport that sends something else (Live's `functionResponse`) passes its own. */
  readBack?: (settlement: ToolExecuteSettlement) => ToolCallEnd['result'];
}

function turnReadBack({ modelResult }: ToolExecuteSettlement): ToolCallEnd['result'] {
  return modelResult
    ? { text: formatToolResult(modelResult), parts: modelResult.parts }
    : undefined;
}

/** The service a refused sign-in names, from the tool's own auth config. */
function refusedSignInService(tool: RegisteredTool, resume: ToolContext['resume']) {
  if (!resume?.signIn || tool.type === 'builtin') return undefined;
  return tool.auth?.service;
}

/**
 * A gate nobody answered: a sign-in for `expiredService` whose link expired, or any other gate
 * left behind. Both settle as `cancelled`.
 */
export function lapsedGateFailure(
  toolName: string,
  expiredService: string | undefined,
  lexicon: LexiconOverrides | undefined,
): ToolFailure {
  if (expiredService) {
    return {
      code: 'expired',
      kind: 'cancelled',
      message: lexiconText('sign_in.expired', { service: expiredService }, lexicon),
    };
  }
  return {
    code: 'cancelled',
    kind: 'cancelled',
    message: lexiconText('session.abandon_gated', { tool: toolName }, lexicon),
  };
}

/** `abandoned` and `expired` settle as `cancelled`. */
function refusalFailure(
  tool: RegisteredTool,
  resume: ToolContext['resume'],
  lexicon: LexiconOverrides | undefined,
): ToolFailure {
  const service = refusedSignInService(tool, resume);
  const cause = resume?.cause ?? 'declined';
  if (cause === 'declined') {
    return {
      code: 'denied',
      kind: 'declined',
      message: service
        ? lexiconText('sign_in.declined', { service }, lexicon)
        : lexiconText('session.tool_denied', { tool: tool.name }, lexicon),
    };
  }
  return lapsedGateFailure(tool.name, cause === 'expired' ? service : undefined, lexicon);
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

export async function* executeRegisteredTool(
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
    origin: tool ? originOfTool(tool.type) : undefined,
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
    // The host stopped reading mid-call.
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
  const { profile, name, input, callId, ctx, snapshot, stages } = args;
  const safeInput = plainToolInput(input);
  const base = { name, callId };
  if (!tool) {
    const failure: ToolFailure = {
      code: 'unknown_tool',
      kind: 'request',
      message: lexiconText('tool.not_registered', { tool: name }, profile.lexicon),
    };
    yield failureEvent(base, failure);
    return earlyFailure(failure);
  }
  if (tool.type === 'builtin') {
    if (!snapshot) {
      const failure: ToolFailure = {
        code: 'provider_native',
        kind: 'request',
        message: lexiconText('tool.builtin_needs_snapshot', { tool: name }, profile.lexicon),
      };
      yield failureEvent(base, failure);
      return earlyFailure(failure);
    }
    const fullCtx: ToolContext = { ...ctx, callId, profile };
    return yield* executeBuiltin(tool, fullCtx, base, snapshot);
  }

  const eligibility = registeredEligibilityFailure({
    tool,
    profile,
    name,
    resume: ctx.resume,
    snapshot,
  });
  if (eligibility) {
    yield failureEvent(base, eligibility);
    return earlyFailure(eligibility);
  }

  if (isGateResumeDenied(ctx.resume)) {
    return yield* settleToolFailure(
      resultGuard(tool, { ...ctx, callId, profile }, snapshot, stages?.span),
      base,
      refusalFailure(tool, ctx.resume, profile.lexicon),
      stages,
      { toolName: name, callId, input: safeInput, callNotStarted: true, denied: true },
    );
  }

  const fullCtx: ToolContext = { ...ctx, callId, profile };
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const provenance = provenanceFor(tool);

  const argsStart = performance.now();
  const argEvent = toolCallEvent(inspectToolArguments(safeInput, policy), provenance);
  recordToolCheck(stages?.span, 'tool_arguments', performance.now() - argsStart, argEvent);
  if (argEvent) {
    yield { type: 'guardrail', guardrail: argEvent };
  }

  const taintStart = performance.now();
  const taintVerdict = checkTaintGate(ctx.turn?.taint, tool.access, policy, profile.lexicon);
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

  return yield* settleByType(args.tools, tool, safeInput, fullCtx, base, snapshot, stages);
}

async function* settleByType(
  tools: ToolRegistry,
  tool: RegisteredTool,
  safeInput: unknown,
  fullCtx: ToolContext,
  base: ToolCallBase,
  snapshot: TurnToolSnapshot | undefined,
  stages: ToolStageSupport | undefined,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { name } = tool;
  if (tool.type === 'function') {
    return yield* executeFunction(tools, tool, safeInput, fullCtx, base, snapshot, stages);
  }

  if (tool.type !== 'http' && tool.type !== 'mcp') {
    return earlyFailure({
      code: 'unknown_tool',
      kind: 'request',
      message: lexiconText('tool.unsupported_type', { tool: name }, fullCtx.profile.lexicon),
    });
  }
  const remoteOutcome: ToolBodyOutcome =
    tool.type === 'http'
      ? yield* executeHttpTool(tool, safeInput, fullCtx, base, stages)
      : yield* executeMcpTool(tool, safeInput, fullCtx, base, stages, tools.mcpSessions);
  return yield* settleBodyOutcome({
    outcome: remoteOutcome,
    tool,
    base,
    callId: base.callId,
    safeInput,
    stages,
    guard: resultGuard(tool, fullCtx, snapshot, stages?.span),
    lexicon: fullCtx.profile.lexicon,
  });
}

/** Every tool returns through here, so a new tool type cannot skip the fence, redaction or provenance label. */
interface GuardInputs {
  provenance: Provenance;
  policy: ReturnType<typeof resolveGuardrailPolicy>;
  callableTools: readonly string[];
  lexicon: LexiconOverrides | undefined;
  span: SpanHandle | undefined;
}

/**
 * A failure's message is redacted under full detection, whatever the profile
 * enables: the kernel frames it for the model as a system report, and a remote
 * server writes its own error strings. What it changed is a decision like any
 * other, reported and timed; the framed message is then guarded as a result.
 */
function* guardFailure(
  failure: ToolFailure,
  guard: GuardInputs,
): Generator<TurnEvent, ModelToolResult> {
  const start = performance.now();
  const checked = guardToolFailureText(failure.message, guard.provenance, {
    ...guard.policy,
    sanitizeInput: true,
    redactSensitive: true,
  });
  recordToolCheck(guard.span, 'tool_failure', performance.now() - start, checked.event);
  if (checked.event) {
    yield { type: 'guardrail', guardrail: checked.event };
  }
  return yield* guardResult(
    formatToolFailureForModel({ ...failure, message: checked.text }),
    guard,
  );
}

function* guardResult(
  result: ModelToolResult,
  guard: GuardInputs,
): Generator<TurnEvent, ModelToolResult> {
  const { provenance, span } = guard;
  const start = performance.now();
  const guarded = guardToolResult(
    result.finding,
    result.data,
    provenance,
    guard.policy,
    guard.callableTools,
    guard.lexicon,
  );
  recordToolCheck(span, 'tool_result', performance.now() - start, guarded.event);
  if (guarded.event) {
    yield { type: 'guardrail', guardrail: guarded.event };
  }
  return {
    ...result,
    modelText: guarded.text,
    provenance,
    ...(guarded.suspicious ? { suspicious: guarded.suspicious } : {}),
  };
}

export type { RegisteredToolCall, ToolStageSupport };
export { startToolExecution };
