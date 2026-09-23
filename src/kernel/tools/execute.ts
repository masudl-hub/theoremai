/**
 * Shared tool execution core for model-initiated and host-initiated calls.
 *
 * @module
 */

import { isAbortError, throwIfAborted } from '../../guardrails/error.ts';
import { lexiconText } from '../../guardrails/lexicon.ts';
import { resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { sanitizeText } from '../../guardrails/sanitize.ts';
import {
  checkTaintGate,
  composeToolText,
  guardToolFailureText,
  guardToolResult,
  inspectToolArguments,
  toolCallEvent,
} from '../../guardrails/tool-result.ts';
import type { Provenance, ToolOrigin } from '../../guardrails/types.ts';
import type { SpanHandle, TraceAttributes } from '../../observability/trace-span.ts';
import { startToolTrace, type ToolCallEnd, type ToolOutcome } from '../engine/tool-trace.ts';
import { isAwaitingUserInput } from '../stages.ts';
import type { InteractionPart, Profile, TurnEvent, TurnHistoryMessage } from '../types.ts';
import { failureEvent, messageOf, startToolExecution, toolEvent } from './events.ts';
import {
  checkPermission,
  isGateResumeDenied,
  isGateResumeGranted,
  isResumeContinuation,
} from './permission.ts';
import { getTool } from './registry.ts';
import {
  executeHttpTool,
  executeMcpTool,
  modelResultFromOutput,
  parseToolOutput,
} from './remote.ts';
import { promoteLoadedTools } from './resolve.ts';
import { plainToolInput } from './schema.ts';
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
  ToolCallEvent,
  ToolContext,
  ToolFailure,
  ToolGate,
  ToolStreamEvent,
  TurnToolSnapshot,
} from './types.ts';

export {
  checkPermission,
  isGateResumeGranted,
  isResumeContinuation,
  permissionGranted,
} from './permission.ts';

/** Map a registered tool's type onto the origin its bytes carry. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate host-emitted InteractionPart shapes; drop invalid entries. */
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

/** Copy tool output for model `data`, omitting media `parts`. */
export function leanToolResultData(output: unknown): unknown {
  if (!isRecord(output)) return output;
  const { parts: _parts, ...rest } = output;
  return rest;
}

/** @deprecated Gates use `ToolGate` / `phase: 'gate'`. Kept for type narrowing during migration. */
export function isToolPause(value: ToolFailure | { kind: string }): value is {
  kind: 'interactive' | 'confirmation' | 'permission' | 'auth';
} {
  return (
    'kind' in value &&
    (value.kind === 'interactive' ||
      value.kind === 'confirmation' ||
      value.kind === 'permission' ||
      value.kind === 'auth')
  );
}

export function* yieldHandlerSideEvent(
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
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

/** Run the handler, yielding stream side-events live; returns terminal output. */
async function* runHandler<TIn, TOut>(
  handler: FunctionToolDef<TIn, TOut>['handler'],
  input: TIn,
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
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

export function projectForModel(tool: FunctionToolDef, output: unknown): ModelToolResult {
  if (tool.exposeToModel === false) {
    return { finding: 'Completed.' };
  }
  if (isAwaitingUserInput(output)) {
    return {
      finding: lexiconText('tool.awaiting_user', { kind: output.kind, prompt: output.prompt }),
      data: leanToolResultData(output),
    };
  }
  const finding =
    typeof output === 'object' && output !== null && 'finding' in output
      ? String((output as { finding?: unknown }).finding)
      : JSON.stringify(output);
  const parts =
    isRecord(output) && 'parts' in output ? coerceToolResultParts(output.parts) : undefined;
  return {
    finding: sanitizeText(finding),
    data: leanToolResultData(output),
    ...(parts ? { parts } : {}),
  };
}

/**
 * Format model-facing tool output for provider history continuation.
 *
 * Text projection only — never embeds `parts[].data`; media travels on
 * `TurnHistoryMessage.parts` and adapters wire it from there.
 *
 * `executeRegisteredTool` guards at the boundary and leaves `modelText` behind, so
 * the common path returns already-fenced text. A result recorded elsewhere — a
 * host replaying a transcript — is guarded here instead, under full detection.
 */
export function formatToolResult(result: ModelToolResult): string {
  if (result.modelText !== undefined) {
    return result.modelText;
  }
  return sanitizeText(composeToolText(result.finding, result.data));
}

/**
 * Format a tool failure for provider history — structured so the model (or host)
 * sees the code.
 *
 * The message is remote-authored on HTTP and MCP tools, so it is redacted before
 * the kernel frames it as a system report.
 */
export function formatToolFailureForModel(
  failure: ToolFailure,
  provenance?: Provenance,
  policy: ReturnType<typeof resolveGuardrailPolicy> = resolveGuardrailPolicy(undefined),
): ModelToolResult {
  const safe = provenance
    ? guardToolFailureText(failure.message, provenance, policy).text
    : sanitizeText(failure.message);
  return {
    finding: `Tool error (${failure.code}): ${safe}`,
    data: {
      ok: false,
      code: failure.code,
      message: safe,
      ...(failure.details !== undefined ? { details: failure.details } : {}),
    },
  };
}

/** True when this tool is the profile's T2 loader: its output drives the snapshot. */
function loadsT2(tool: FunctionToolDef, ctx: ToolContext): boolean {
  if (
    ctx.profile.type === 'speech' ||
    ctx.profile.type === 'live' ||
    ctx.profile.type === 'host' ||
    ctx.profile.type === 'decision'
  ) {
    return false;
  }
  return ctx.profile.tools.t2Loader === tool.name;
}

function applyT2LoaderPromotion(
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
        message: lexiconText('tool.t2_loader_needs_snapshot', { tool: tool.name }),
      },
    };
  }
  const loaded = extractLoadedIds(checkedData);
  if (!loaded) {
    return {
      ok: false,
      failure: {
        code: 'invalid_output',
        message: lexiconText('tool.t2_loader_shape', { tool: tool.name }),
      },
    };
  }
  const { promoted, failure: promoteFailure } = promoteLoadedTools(snapshot, loaded, ctx.profile);
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
        message: lexiconText('tool.t2_loader_output_invalid'),
        details: rechecked.error.flatten(),
      },
    };
  }
  return { ok: true, output: rechecked.data };
}

/** Settlement returned from `executeRegisteredTool` / function execute. */
export type ToolExecuteSettlement = {
  modelResult?: ModelToolResult;
  gated?: ToolGate;
  aborted?: boolean | { reason?: string };
  callNotStarted?: boolean;
  awaiting?: boolean;
  failure?: ToolFailure;
  /** Raw tool output when the body completed (incl. awaiting). */
  outputRaw?: unknown;
  /** A policy or the host refused the call; `failure` says why. */
  denied?: true;
  /**
   * post_tool inject messages — apply after recording the provider tool result
   * so Interactions continuation exists.
   */
  pendingInject?: TurnHistoryMessage[];
};

/** Transport-specific validate + project for a host-mutated output, unguarded. */
type Reproject = (
  output: unknown,
) =>
  | { ok: true; outputRaw: unknown; modelResult: ModelToolResult }
  | { ok: false; failure: ToolFailure };

/** Guard bound to one call: fence, redaction, provenance for whatever the model will see. */
type ResultGuard = (result: ModelToolResult) => Generator<TurnEvent, ModelToolResult>;

/** What the transport produced before `post_tool`: a completed body or a failure. */
type Provisional =
  | { outputRaw: unknown; modelResult: ModelToolResult }
  | {
      failure: ToolFailure;
      modelResult: ModelToolResult;
      callNotStarted?: boolean;
      denied?: true;
    };

/**
 * Settle a tool call, once, for every transport: guard the provisional result,
 * run `post_tool`, apply a host `deny` or `mutate` (re-projected and re-guarded),
 * then emit the single terminal `tool` event with what the model actually gets.
 * `reproject` is absent when the kernel owns the output (the T2 loader), which
 * makes `mutate` a warning instead of a replacement.
 */
async function* settleToolCall(args: {
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>;
  toolName: string;
  callId: string;
  input?: unknown;
  stages?: ToolStageSupport;
  provisional: Provisional;
  guard: ResultGuard;
  reproject?: Reproject;
}): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { base, toolName, callId, input, stages, provisional, guard, reproject } = args;
  let modelResult = yield* guard(provisional.modelResult);
  let failure = 'failure' in provisional ? provisional.failure : undefined;
  let outputRaw = 'outputRaw' in provisional ? provisional.outputRaw : undefined;
  const callNotStarted = 'callNotStarted' in provisional ? provisional.callNotStarted : undefined;
  let denied = 'denied' in provisional ? provisional.denied : undefined;
  let awaiting = !failure && isAwaitingUserInput(outputRaw);
  let post: PostToolStageOutcome | undefined;

  if (stages) {
    // Do not applyInject here — the text runner records the tool result first.
    const { applyInject: _apply, ...rest } = stages;
    post = yield* runPostToolStages({
      stages: rest,
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
    if (post.deny) {
      denied = true;
      failure = { code: post.deny.code, message: post.deny.message };
      modelResult = yield* guard(formatToolFailureForModel(failure));
      outputRaw = undefined;
      awaiting = false;
    } else if (post.mutate && reproject) {
      const next = reproject(plainToolInput(post.mutate.output));
      if (next.ok) {
        failure = undefined;
        outputRaw = next.outputRaw;
        modelResult = yield* guard(next.modelResult);
        awaiting = isAwaitingUserInput(outputRaw);
      } else {
        failure = next.failure;
        modelResult = yield* guard(formatToolFailureForModel(next.failure));
        outputRaw = undefined;
        awaiting = false;
      }
    }
  }

  yield failure
    ? failureEvent(base, failure)
    : toolEvent(base, { phase: 'complete', output: outputRaw });
  return {
    modelResult,
    ...(failure ? { failure } : { outputRaw }),
    ...(denied ? { denied } : {}),
    ...(callNotStarted ? { callNotStarted: true as const } : {}),
    ...(awaiting ? { awaiting: true as const } : {}),
    ...(post?.abort !== undefined ? { aborted: post.abort } : {}),
    ...(post?.inject?.length ? { pendingInject: post.inject } : {}),
  };
}

/** Settle a call that failed before or during its body. */
function settleToolFailure(
  guard: ResultGuard,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
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
      modelResult: formatToolFailureForModel(failure),
      ...(args.callNotStarted ? { callNotStarted: true } : {}),
      ...(args.denied ? { denied: true } : {}),
    },
  });
}

/** The one guard every model-facing tool result passes through, bound to this call. */
function resultGuard(
  tool: RegisteredTool,
  ctx: ToolContext,
  snapshot: TurnToolSnapshot | undefined,
): ResultGuard {
  const provenance = provenanceFor(tool);
  const policy = resolveGuardrailPolicy(ctx.profile.guardrails);
  const callableTools = snapshot?.executable ?? [];
  return (result) => guardResult(result, provenance, policy, callableTools);
}

/** Tool `preTool` + host `pre_tool` + mutate re-parse, mapped onto a function-tool settlement. */
async function* runFunctionPreBodyStages(args: {
  tool: FunctionToolDef;
  input: unknown;
  ctx: ToolContext;
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>;
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
    callId: base.callId ?? '',
    input: args.input,
    callNotStarted: true,
    ...(pre.denied ? { denied: true } : {}),
  });
}

/**
 * Build the `Reproject` for a host `post_tool` mutate: re-validate the replacement
 * output through the transport's own parser, then project it the transport's way.
 */
type ParsedOutput =
  | { success: true; data: unknown }
  | { success: false; error: { flatten: () => unknown } };

function makeReproject(
  parse: (value: unknown) => ParsedOutput,
  project: (data: unknown) => ModelToolResult,
): Reproject {
  return (output) => {
    const checked = parse(output);
    if (!checked.success) {
      return {
        ok: false,
        failure: {
          code: 'invalid_output',
          message: lexiconText('tool.output_invalid_after_mutate'),
          details: checked.error.flatten(),
        },
      };
    }
    return { ok: true, outputRaw: checked.data, modelResult: project(checked.data) };
  };
}

export async function* executeFunction(
  tool: FunctionToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  snapshot?: TurnToolSnapshot,
  stages?: ToolStageSupport,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const guard = resultGuard(tool, ctx, snapshot);
  const callId = base.callId ?? '';
  const parsed = yield* startToolExecution(tool, rawInput, ctx, base);
  if (!parsed.ok) {
    return yield* settleToolFailure(
      guard,
      base,
      { code: 'invalid_input', message: lexiconText('tool.input_invalid') },
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
    yield* emitGateSettlement({ base, gate: permissionGate, callId, toolName: tool.name });
    return { gated: permissionGate, callNotStarted: true };
  }

  throwIfAborted(ctx.signal);

  const preBody = yield* runFunctionPreBodyStages({ tool, input, ctx, base, stages, guard });
  if (!('ok' in preBody)) {
    return preBody;
  }
  input = preBody.input;

  throwIfAborted(ctx.signal);
  const fail = (failure: ToolFailure) =>
    settleToolFailure(guard, base, failure, stages, { toolName: tool.name, callId, input });

  let output: unknown;
  try {
    output = yield* runHandler(tool.handler, input as never, ctx, base);
  } catch (err) {
    return yield* fail({ code: 'handler_error', message: messageOf(err) });
  }
  if (output === undefined) {
    return yield* fail({ code: 'invalid_output', message: lexiconText('tool.handler_no_output') });
  }
  const checked = tool.output.safeParse(output);
  if (!checked.success) {
    return yield* fail({
      code: 'invalid_output',
      message: lexiconText('tool.output_invalid'),
      details: checked.error.flatten(),
    });
  }
  const promoted = applyT2LoaderPromotion(tool, checked.data, ctx, snapshot);
  if (!promoted.ok) {
    return yield* fail(promoted.failure);
  }

  // The T2 loader's output drives the snapshot; the kernel owns it, so no mutate.
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
      modelResult: projectForModel(tool, promoted.output),
    },
    ...(ownsOutput
      ? {}
      : {
          reproject: makeReproject(
            (v) => tool.output.safeParse(v),
            (data) => projectForModel(tool, data),
          ),
        }),
  });
}

export function notLoadedMessage(tool: { name: string; loadTier?: string }): string {
  if (tool.loadTier === 'T1') {
    return lexiconText('tool.not_wired_t1', { tool: tool.name });
  }
  if (tool.loadTier === 'T2') {
    return lexiconText('tool.not_loaded_t2', { tool: tool.name });
  }
  return lexiconText('tool.not_visible', { tool: tool.name });
}

export function extractLoadedIds(output: unknown): string[] | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return undefined;
  }
  const loaded = (output as { loaded?: unknown }).loaded;
  if (!Array.isArray(loaded) || !loaded.every((id) => typeof id === 'string')) {
    return undefined;
  }
  return loaded;
}

function earlyFailure(failure: ToolFailure): ToolExecuteSettlement {
  return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
}

export async function* executeBuiltin(
  tool: { name: string },
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  snapshot: TurnToolSnapshot,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  yield toolEvent(base, { phase: 'running' });
  throwIfAborted(ctx.signal);
  if (!snapshot.builtins.includes(tool.name)) {
    const failure: ToolFailure = {
      code: 'not_loaded',
      message: lexiconText('tool.builtin_not_enabled', { tool: tool.name }),
    };
    yield failureEvent(base, failure);
    return earlyFailure(failure);
  }
  const failure: ToolFailure = {
    code: 'provider_native',
    message: lexiconText('tool.provider_native', { tool: tool.name }),
  };
  yield failureEvent(base, failure);
  return earlyFailure(failure);
}

/** Snapshot / allowlist / load-tier checks before body execution. */
function registeredEligibilityFailure(args: {
  tool: NonNullable<ReturnType<typeof getTool>>;
  profile: Profile;
  name: string;
  resume: ToolContext['resume'];
  snapshot?: TurnToolSnapshot;
}): ToolFailure | undefined {
  const { tool, profile, name, resume, snapshot } = args;
  if (
    profile.type === 'speech' ||
    profile.type === 'decision' ||
    !profile.tools.allow.includes(name)
  ) {
    return {
      code: 'not_allowed',
      message: lexiconText('tool.not_allowed', { tool: name, profile: profile.id }),
    };
  }
  if (!snapshot) return undefined;
  const continuing = isResumeContinuation(resume);
  if (!continuing && !snapshot.gated.includes(name)) {
    return { code: 'not_gated', message: lexiconText('tool.not_eligible', { tool: name }) };
  }
  if (!snapshot.visible.includes(name)) {
    const skipLoadCheck = continuing && tool.loadTier === 'T0';
    if (!skipLoadCheck) {
      return { code: 'not_loaded', message: notLoadedMessage(tool) };
    }
  }
  return undefined;
}

async function* settleRemoteOutcome(args: {
  outcome: ToolBodyOutcome;
  tool: HttpToolDef | McpToolDef;
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>;
  callId: string;
  safeInput: unknown;
  stages?: ToolStageSupport;
  guard: ResultGuard;
}): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { outcome, tool, base, callId, safeInput, stages, guard } = args;
  const name = tool.name;

  if (outcome.kind === 'gated') {
    if (outcome.gate.kind === 'confirmation') {
      return { gated: outcome.gate, callNotStarted: true };
    }
    yield* emitGateSettlement({ base, gate: outcome.gate, callId, toolName: name });
    return { gated: outcome.gate, callNotStarted: true };
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
    reproject: makeReproject((v) => parseToolOutput(tool.output, v), modelResultFromOutput),
  });
}

/** One registered-tool call: who asks, what for, and where it records. */
interface RegisteredToolCall {
  profile: Profile;
  name: string;
  input: unknown;
  callId: string;
  ctx: Omit<ToolContext, 'callId' | 'profile'>;
  snapshot?: TurnToolSnapshot;
  stages?: ToolStageSupport;
  /**
   * Opens this call's `execute_tool` span (a turn's child, or a host invoke's
   * root). The span then carries `pre_tool` / `post_tool` and is handed to
   * the tool as `ctx.traceparent`. Omitted: the call is not traced.
   */
  openSpan?: (name: string, attributes: TraceAttributes) => SpanHandle;
  /**
   * What the model reads back from a settled call, as the span records it.
   * Default: the text and media a turn sends (`turnReadBack`). A transport that
   * sends something else (Live's `functionResponse`) passes its own.
   */
  readBack?: (settlement: ToolExecuteSettlement) => ToolCallEnd['result'];
}

/** What a turn sends the model for a settled call: the formatted text and any media. */
function turnReadBack({ modelResult }: ToolExecuteSettlement): ToolCallEnd['result'] {
  return modelResult
    ? { text: formatToolResult(modelResult), parts: modelResult.parts }
    : undefined;
}

/** The gate answer a resumed call carries: approved, refused, or none. */
function resumeApproval(resume: ToolContext['resume']): boolean | undefined {
  if (isGateResumeGranted(resume)) return true;
  if (isGateResumeDenied(resume)) return false;
  return undefined;
}

/** How a settled call ends its span. */
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
    ...(failure ? { errorType: failure.code } : {}),
  };
}

/**
 * Execute one registered tool call through the shared pipeline, recording it
 * as an `execute_tool` span when `openSpan` is given.
 */
export async function* executeRegisteredTool(
  args: RegisteredToolCall,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const tool = getTool(args.name);
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
    // The host stopped reading mid-call: close the body and say so.
    if (!trace.span.ended) {
      trace.end({ outcome: 'cancelled' });
      await exec.return({});
    }
  }
}

/** Tool arguments as an object, the shape tool events carry. */
export function toolCallArguments(safeInput: unknown): Record<string, unknown> {
  return typeof safeInput === 'object' && safeInput !== null && !Array.isArray(safeInput)
    ? (safeInput as Record<string, unknown>)
    : { value: safeInput };
}

async function* runRegisteredTool(
  args: RegisteredToolCall,
  tool: RegisteredTool | undefined,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { profile, name, input, callId, ctx, snapshot, stages } = args;
  const safeInput = plainToolInput(input);
  const base = { name, callId, arguments: toolCallArguments(safeInput) };
  if (!tool) {
    const failure: ToolFailure = {
      code: 'unknown_tool',
      message: lexiconText('tool.not_registered', { tool: name }),
    };
    yield failureEvent(base, failure);
    return earlyFailure(failure);
  }
  if (tool.type === 'builtin') {
    if (!snapshot) {
      const failure: ToolFailure = {
        code: 'provider_native',
        message: lexiconText('tool.builtin_needs_snapshot', { tool: name }),
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

  // Host denied after a gate — synthetic failure + post_tool, no body.
  if (isGateResumeDenied(ctx.resume)) {
    return yield* settleToolFailure(
      resultGuard(tool, { ...ctx, callId, profile }, snapshot),
      base,
      { code: 'denied', message: lexiconText('session.tool_denied', { tool: name }) },
      stages,
      { toolName: name, callId, input: safeInput, callNotStarted: true, denied: true },
    );
  }

  const fullCtx: ToolContext = { ...ctx, callId, profile };
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const provenance = provenanceFor(tool);

  const argEvent = toolCallEvent(inspectToolArguments(safeInput, policy), provenance);
  if (argEvent) {
    yield { type: 'guardrail', guardrail: argEvent };
  }

  const taintVerdict = checkTaintGate(ctx.turn?.taint, tool.access, policy);
  const taintEvent = toolCallEvent(taintVerdict, provenance);
  if (taintEvent) {
    yield { type: 'guardrail', guardrail: taintEvent };
  }
  if (taintVerdict.action === 'block') {
    const failure: ToolFailure = {
      code: 'tainted_turn',
      message: taintVerdict.rejection,
    };
    yield failureEvent(base, failure);
    return { ...earlyFailure(failure), denied: true };
  }

  return yield* settleByType(tool, safeInput, fullCtx, base, snapshot, stages);
}

/** Run the body for the tool's transport and settle it through `settleToolCall`. */
async function* settleByType(
  tool: RegisteredTool,
  safeInput: unknown,
  fullCtx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  snapshot: TurnToolSnapshot | undefined,
  stages: ToolStageSupport | undefined,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { name } = tool;
  if (tool.type === 'function') {
    return yield* executeFunction(tool, safeInput, fullCtx, base, snapshot, stages);
  }

  if (tool.type !== 'http' && tool.type !== 'mcp') {
    return earlyFailure({
      code: 'unknown_tool',
      message: lexiconText('tool.unsupported_type', { tool: name }),
    });
  }
  // HTTP / MCP: schema → permission → auth → preTool → body (inside remote).
  const remoteOutcome: ToolBodyOutcome =
    tool.type === 'http'
      ? yield* executeHttpTool(tool, safeInput, fullCtx, base, stages)
      : yield* executeMcpTool(tool, safeInput, fullCtx, base, stages);
  return yield* settleRemoteOutcome({
    outcome: remoteOutcome,
    tool,
    base,
    callId: base.callId ?? '',
    safeInput,
    stages,
    guard: resultGuard(tool, fullCtx, snapshot),
  });
}

/**
 * Guard a tool result before it becomes model context.
 *
 * Every tool returns through here, so the fence, the redaction, and the
 * provenance label are applied once and cannot be skipped by adding a tool type.
 */
function* guardResult(
  result: ModelToolResult,
  provenance: Provenance,
  policy: ReturnType<typeof resolveGuardrailPolicy>,
  callableTools: readonly string[],
): Generator<TurnEvent, ModelToolResult> {
  const guarded = guardToolResult(result.finding, result.data, provenance, policy, callableTools);
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

export function newCallId(name: string): string {
  return `call_${name}_${Date.now()}`;
}
