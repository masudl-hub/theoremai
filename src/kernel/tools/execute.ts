/**
 * Shared tool execution core for model-initiated and host-initiated calls.
 *
 * @module
 */

import { throwIfAborted } from '../../guardrails/error.ts';
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
import { isAwaitingUserInput } from '../stages.ts';
import type { InteractionPart, Profile, TurnEvent, TurnHistoryMessage } from '../types.ts';
import { failureEvent, startToolExecution, toolEvent } from './events.ts';
import { checkPermission, isGateResumeDenied, isResumeContinuation } from './permission.ts';
import { getTool } from './registry.ts';
import { executeHttpTool, executeMcpTool, type RemoteToolOutcome } from './remote.ts';
import { promoteLoadedTools } from './resolve.ts';
import {
  emitGateSettlement,
  gateEvent,
  runPostToolStages,
  runPreToolPipeline,
  type ToolStageSupport,
} from './stage-run.ts';
import type {
  FunctionToolDef,
  ModelToolResult,
  RegisteredTool,
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

function applyT2LoaderPromotion(
  tool: FunctionToolDef,
  checkedData: unknown,
  ctx: ToolContext,
  snapshot: TurnToolSnapshot | undefined,
): { ok: true; output: unknown } | { ok: false; failure: ToolFailure } {
  if (ctx.profile.type === 'speech' || ctx.profile.type === 'live' || ctx.profile.type === 'host') {
    return { ok: true, output: checkedData };
  }
  if (ctx.profile.tools.t2Loader !== tool.name) {
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
  /**
   * post_tool inject messages — apply after recording the provider tool result
   * so Interactions continuation exists.
   */
  pendingInject?: TurnHistoryMessage[];
};

async function* settlePostTool(
  stages: ToolStageSupport | undefined,
  args: {
    toolName: string;
    callId: string;
    input?: unknown;
    callNotStarted?: boolean;
    outputRaw?: unknown;
    outputModel?: ModelToolResult;
    failure?: ToolFailure;
    awaiting?: boolean;
  },
): AsyncGenerator<
  TurnEvent,
  { aborted?: boolean | { reason?: string }; pendingInject?: TurnHistoryMessage[] }
> {
  if (!stages) return {};
  // Do not applyInject here — text runner must record the tool result first.
  const { applyInject: _apply, ...rest } = stages;
  const post = yield* runPostToolStages({ stages: rest, ...args });
  return {
    ...(post.abort !== undefined ? { aborted: post.abort } : {}),
    ...(post.inject?.length ? { pendingInject: post.inject } : {}),
  };
}

/** Emit failure + post_tool and return a failed settlement (collapses clone sites). */
async function* settleToolFailure(
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  failure: ToolFailure,
  stages: ToolStageSupport | undefined,
  args: {
    toolName: string;
    callId: string;
    input?: unknown;
    callNotStarted?: boolean;
  },
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  yield failureEvent(base, failure);
  const modelResult = formatToolFailureForModel(failure);
  const post = yield* settlePostTool(stages, {
    toolName: args.toolName,
    callId: args.callId,
    input: args.input,
    callNotStarted: args.callNotStarted,
    failure,
    outputModel: modelResult,
  });
  return {
    modelResult,
    failure,
    ...(args.callNotStarted ? { callNotStarted: true as const } : {}),
    ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
    ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
  };
}

/**
 * Tool `preTool` + host `pre_tool` + mutate re-parse for local function tools.
 * Mirrors remote `runRemotePreBodyStages` so the two paths cannot drift in structure.
 */
async function* runFunctionPreBodyStages(args: {
  tool: FunctionToolDef;
  input: unknown;
  ctx: ToolContext;
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>;
  stages?: ToolStageSupport;
}): AsyncGenerator<TurnEvent, { ok: true; input: unknown } | ToolExecuteSettlement> {
  const { tool, ctx, base, stages } = args;
  const pipeline = yield* runPreToolPipeline({
    tool,
    input: args.input,
    ctx,
    callId: base.callId ?? '',
    stages,
  });
  if (pipeline.status === 'passthrough') {
    return { ok: true, input: pipeline.input };
  }
  const pre = pipeline.outcome;

  if (pre.kind === 'abort') {
    return { aborted: pre.abort, callNotStarted: true };
  }
  if (pre.kind === 'gate') {
    yield gateEvent(base, pre.gate);
    return { gated: pre.gate, callNotStarted: true };
  }
  if (pre.kind === 'deny' || pre.kind === 'error') {
    return yield* settleToolFailure(base, pre.failure, stages, {
      toolName: tool.name,
      callId: base.callId ?? '',
      input: args.input,
      callNotStarted: true,
    });
  }

  const input = pre.input;
  const reparsed = tool.input.safeParse(input);
  if (!reparsed.success) {
    return yield* settleToolFailure(
      base,
      {
        code: 'invalid_input',
        message: lexiconText('tool.input_invalid_after_mutate'),
        details: reparsed.error.flatten(),
      },
      stages,
      {
        toolName: tool.name,
        callId: base.callId ?? '',
        input,
        callNotStarted: true,
      },
    );
  }
  return { ok: true, input: reparsed.data };
}

export async function* executeFunction(
  tool: FunctionToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  snapshot?: TurnToolSnapshot,
  stages?: ToolStageSupport,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const parsed = yield* startToolExecution(tool, rawInput, ctx, base);
  if (!parsed.ok) {
    return yield* settleToolFailure(
      base,
      { code: 'invalid_input', message: lexiconText('tool.input_invalid') },
      stages,
      { toolName: tool.name, callId: base.callId ?? '', callNotStarted: true },
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
      callId: base.callId ?? '',
      toolName: tool.name,
    });
    return { gated: permissionGate, callNotStarted: true };
  }

  throwIfAborted(ctx.signal);

  const preBody = yield* runFunctionPreBodyStages({ tool, input, ctx, base, stages });
  if (!('ok' in preBody)) {
    return preBody;
  }
  input = preBody.input;

  throwIfAborted(ctx.signal);
  try {
    const output = yield* runHandler(tool.handler, input as never, ctx, base);
    if (output === undefined) {
      return yield* settleToolFailure(
        base,
        { code: 'invalid_output', message: lexiconText('tool.handler_no_output') },
        stages,
        { toolName: tool.name, callId: base.callId ?? '', input },
      );
    }
    const checked = tool.output.safeParse(output);
    if (!checked.success) {
      return yield* settleToolFailure(
        base,
        {
          code: 'invalid_output',
          message: lexiconText('tool.output_invalid'),
          details: checked.error.flatten(),
        },
        stages,
        { toolName: tool.name, callId: base.callId ?? '', input },
      );
    }

    const promoted = applyT2LoaderPromotion(tool, checked.data, ctx, snapshot);
    if (!promoted.ok) {
      return yield* settleToolFailure(base, promoted.failure, stages, {
        toolName: tool.name,
        callId: base.callId ?? '',
        input,
      });
    }

    const awaiting = isAwaitingUserInput(promoted.output);
    const modelResult = projectForModel(tool, promoted.output);
    yield toolEvent(base, {
      phase: 'complete',
      output: promoted.output,
    });
    const post = yield* settlePostTool(stages, {
      toolName: tool.name,
      callId: base.callId ?? '',
      input,
      outputRaw: promoted.output,
      outputModel: modelResult,
      awaiting: awaiting || undefined,
    });
    return {
      modelResult,
      outputRaw: promoted.output,
      awaiting: awaiting || undefined,
      ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
      ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return yield* settleToolFailure(base, { code: 'handler_error', message: msg }, stages, {
      toolName: tool.name,
      callId: base.callId ?? '',
      input,
    });
  }
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

/** Strip prototype-pollution keys from provider/host tool args before validation. */
export function plainToolInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map(plainToolInput);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    out[key] = plainToolInput((input as Record<string, unknown>)[key]);
  }
  return out;
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
  if (profile.type === 'speech' || !profile.tools.allow.includes(name)) {
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
  outcome: RemoteToolOutcome;
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>;
  name: string;
  callId: string;
  safeInput: unknown;
  stages?: ToolStageSupport;
  provenance: ReturnType<typeof provenanceFor>;
  policy: ReturnType<typeof resolveGuardrailPolicy>;
  callableTools: readonly string[];
}): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { outcome, base, name, callId, safeInput, stages, provenance, policy, callableTools } =
    args;

  if (outcome.kind === 'gated') {
    if (outcome.gate.kind === 'confirmation') {
      return { gated: outcome.gate, callNotStarted: true };
    }
    yield* emitGateSettlement({
      base,
      gate: outcome.gate,
      callId,
      toolName: name,
    });
    return { gated: outcome.gate, callNotStarted: true };
  }

  if (outcome.kind === 'aborted') {
    return { aborted: outcome.aborted, callNotStarted: true };
  }

  if (outcome.kind === 'failed') {
    const guarded = yield* guardResult(outcome.modelResult, provenance, policy, callableTools);
    const post = yield* settlePostTool(stages, {
      toolName: name,
      callId,
      input: safeInput,
      callNotStarted: outcome.callNotStarted,
      failure: outcome.failure,
      outputModel: guarded,
    });
    return {
      modelResult: guarded,
      failure: outcome.failure,
      callNotStarted: outcome.callNotStarted,
      ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
      ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
    };
  }

  const guarded = yield* guardResult(outcome.modelResult, provenance, policy, callableTools);
  const post = yield* settlePostTool(stages, {
    toolName: name,
    callId,
    input: safeInput,
    outputRaw: outcome.outputRaw,
    outputModel: guarded,
  });
  return {
    modelResult: guarded,
    outputRaw: outcome.outputRaw,
    ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
    ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
  };
}

export async function* executeRegisteredTool(args: {
  profile: Profile;
  name: string;
  input: unknown;
  callId: string;
  ctx: Omit<ToolContext, 'callId' | 'profile'>;
  snapshot?: TurnToolSnapshot;
  stages?: ToolStageSupport;
}): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const { profile, name, input, callId, ctx, snapshot, stages } = args;
  const tool = getTool(name);
  const safeInput = plainToolInput(input);
  const base = {
    name,
    callId,
    arguments:
      typeof safeInput === 'object' && safeInput !== null && !Array.isArray(safeInput)
        ? (safeInput as Record<string, unknown>)
        : { value: safeInput },
  };
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
      base,
      { code: 'denied', message: lexiconText('session.tool_denied', { tool: name }) },
      stages,
      { toolName: name, callId, input: safeInput, callNotStarted: true },
    );
  }

  const fullCtx: ToolContext = { ...ctx, callId, profile };
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const provenance = provenanceFor(tool);
  const callableTools = snapshot?.executable ?? [];

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
    return earlyFailure(failure);
  }

  if (tool.type === 'function') {
    const settlement = yield* executeFunction(tool, safeInput, fullCtx, base, snapshot, stages);
    if (settlement.modelResult) {
      const guarded = yield* guardResult(settlement.modelResult, provenance, policy, callableTools);
      return { ...settlement, modelResult: guarded };
    }
    return settlement;
  }

  // HTTP / MCP: schema → permission → auth → preTool → body (inside remote).
  const unsupported: ToolFailure = {
    code: 'unknown_tool',
    message: lexiconText('tool.unsupported_type', { tool: name }),
  };
  const remoteOutcome: RemoteToolOutcome =
    tool.type === 'http'
      ? yield* executeHttpTool(tool, safeInput, fullCtx, base, stages)
      : tool.type === 'mcp'
        ? yield* executeMcpTool(tool, safeInput, fullCtx, base, stages)
        : {
            kind: 'failed',
            failure: unsupported,
            modelResult: formatToolFailureForModel(unsupported),
            callNotStarted: true,
          };

  return yield* settleRemoteOutcome({
    outcome: remoteOutcome,
    base,
    name,
    callId,
    safeInput,
    stages,
    provenance,
    policy,
    callableTools,
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

export type { ToolStageSupport };
export { startToolExecution };

export function newCallId(name: string): string {
  return `call_${name}_${Date.now()}`;
}
