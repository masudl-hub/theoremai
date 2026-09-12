/**
 * Shared tool execution core for model-initiated and host-initiated calls.
 *
 * @module
 */

import { throwIfAborted } from '../../guardrails/error.ts';
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
import { getTool } from './registry.ts';
import { executeHttpTool, executeMcpTool } from './remote.ts';
import { promoteLoadedTools } from './resolve.ts';
import {
  gateEvent,
  runPostToolStages,
  runPreToolStages,
  type ToolStageSupport,
} from './stage-run.ts';
import type {
  FunctionToolDef,
  InvokeToolResume,
  ModelToolResult,
  RegisteredTool,
  ToolCallEvent,
  ToolContext,
  ToolFailure,
  ToolGate,
  ToolPermission,
  ToolStreamEvent,
  TurnToolSnapshot,
} from './types.ts';

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

export function isResumeContinuation(resume?: InvokeToolResume): boolean {
  return resume?.value !== undefined || resume?.granted === true;
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

export function permissionGranted(toolName: string, sessionPermissions?: string[]): boolean {
  if (!sessionPermissions) {
    return false;
  }
  return sessionPermissions.includes('*') || sessionPermissions.includes(toolName);
}

export function checkPermission(
  toolName: string,
  permission: ToolPermission,
  sessionPermissions?: string[],
  resume?: InvokeToolResume,
): ToolGate | null {
  if (permission === 'auto') {
    return null;
  }
  if (permission === 'always_confirm') {
    if (resume?.granted === true) {
      return null;
    }
    return {
      kind: 'permission',
      tool: toolName,
      permission,
    };
  }
  if (permissionGranted(toolName, sessionPermissions)) {
    return null;
  }
  return {
    kind: 'permission',
    tool: toolName,
    permission,
  };
}

export function projectForModel(tool: FunctionToolDef, output: unknown): ModelToolResult {
  if (tool.exposeToModel === false) {
    return { finding: 'Completed.' };
  }
  if (isAwaitingUserInput(output)) {
    return {
      finding: `Awaiting user input (${output.kind}): ${output.prompt}`,
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
        message: `tools.t2Loader '${tool.name}' requires a turn tool snapshot`,
      },
    };
  }
  const loaded = extractLoadedIds(checkedData);
  if (!loaded) {
    return {
      ok: false,
      failure: {
        code: 'invalid_output',
        message: `T2 loader '${tool.name}' must return { loaded: string[] }`,
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
        message: 'T2 loader output validation failed after promotion',
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
    const failure: ToolFailure = {
      code: 'invalid_input',
      message: 'Tool input validation failed',
    };
    // startToolExecution already emitted the detailed failure event.
    return { failure, callNotStarted: true };
  }
  let input: unknown = parsed.data;

  const permissionGate = checkPermission(
    tool.name,
    tool.permission,
    ctx.sessionPermissions,
    ctx.resume,
  );
  if (permissionGate) {
    yield gateEvent(base, permissionGate);
    return { gated: permissionGate, callNotStarted: true };
  }

  throwIfAborted(ctx.signal);

  let toolPreTool: import('../stages.ts').StageResult | undefined;
  if (tool.preTool && !isResumeContinuation(ctx.resume)) {
    toolPreTool = (await tool.preTool(input as never, ctx)) ?? undefined;
  }

  if (stages || toolPreTool !== undefined) {
    const support: ToolStageSupport = stages ?? {
      handlers: [],
      step: ctx.turn?.step ?? 1,
      history: () => [],
      injectAllowed: false,
      host: ctx.host,
      signal: ctx.signal,
    };
    const pre = yield* runPreToolStages({
      stages: support,
      toolName: tool.name,
      callId: base.callId ?? '',
      input,
      toolPreTool,
    });
    if (pre.kind === 'abort') {
      return { aborted: pre.abort, callNotStarted: true };
    }
    if (pre.kind === 'gate') {
      yield gateEvent(base, pre.gate);
      return { gated: pre.gate, callNotStarted: true };
    }
    if (pre.kind === 'deny') {
      yield failureEvent(base, pre.failure);
      const modelResult = formatToolFailureForModel(pre.failure);
      const post = yield* settlePostTool(stages, {
        toolName: tool.name,
        callId: base.callId ?? '',
        input,
        callNotStarted: true,
        failure: pre.failure,
        outputModel: modelResult,
      });
      return {
        modelResult,
        failure: pre.failure,
        callNotStarted: true,
        ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
        ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
      };
    }
    if (pre.kind === 'error') {
      yield failureEvent(base, pre.failure);
      const modelResult = formatToolFailureForModel(pre.failure);
      const post = yield* settlePostTool(stages, {
        toolName: tool.name,
        callId: base.callId ?? '',
        input,
        callNotStarted: true,
        failure: pre.failure,
        outputModel: modelResult,
      });
      return {
        modelResult,
        failure: pre.failure,
        callNotStarted: true,
        ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
        ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
      };
    }
    input = pre.input;
    const reparsed = tool.input.safeParse(input);
    if (!reparsed.success) {
      const failure: ToolFailure = {
        code: 'invalid_input',
        message: 'Tool input validation failed after mutate',
        details: reparsed.error.flatten(),
      };
      yield failureEvent(base, failure);
      const modelResult = formatToolFailureForModel(failure);
      const post = yield* settlePostTool(stages, {
        toolName: tool.name,
        callId: base.callId ?? '',
        input,
        callNotStarted: true,
        failure,
        outputModel: modelResult,
      });
      return {
        modelResult,
        failure,
        callNotStarted: true,
        ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
        ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
      };
    }
    input = reparsed.data;
  }

  throwIfAborted(ctx.signal);
  try {
    const output = yield* runHandler(tool.handler, input as never, ctx, base);
    if (output === undefined) {
      const failure: ToolFailure = {
        code: 'invalid_output',
        message: 'Handler returned no output',
      };
      yield failureEvent(base, failure);
      const modelResult = formatToolFailureForModel(failure);
      const post = yield* settlePostTool(stages, {
        toolName: tool.name,
        callId: base.callId ?? '',
        input,
        failure,
        outputModel: modelResult,
      });
      return {
        modelResult,
        failure,
        ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
        ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
      };
    }
    const checked = tool.output.safeParse(output);
    if (!checked.success) {
      const failure: ToolFailure = {
        code: 'invalid_output',
        message: 'Tool output validation failed',
        details: checked.error.flatten(),
      };
      yield failureEvent(base, failure);
      const modelResult = formatToolFailureForModel(failure);
      const post = yield* settlePostTool(stages, {
        toolName: tool.name,
        callId: base.callId ?? '',
        input,
        failure,
        outputModel: modelResult,
      });
      return {
        modelResult,
        failure,
        ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
        ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
      };
    }

    const promoted = applyT2LoaderPromotion(tool, checked.data, ctx, snapshot);
    if (!promoted.ok) {
      yield failureEvent(base, promoted.failure);
      const modelResult = formatToolFailureForModel(promoted.failure);
      const post = yield* settlePostTool(stages, {
        toolName: tool.name,
        callId: base.callId ?? '',
        input,
        failure: promoted.failure,
        outputModel: modelResult,
      });
      return {
        modelResult,
        failure: promoted.failure,
        ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
        ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
      };
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
    const failure: ToolFailure = { code: 'handler_error', message: msg };
    yield failureEvent(base, failure);
    const modelResult = formatToolFailureForModel(failure);
    const post = yield* settlePostTool(stages, {
      toolName: tool.name,
      callId: base.callId ?? '',
      input,
      failure,
      outputModel: modelResult,
    });
    return {
      modelResult,
      failure,
      ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
      ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
    };
  }
}

export function notLoadedMessage(tool: { name: string; loadTier?: string }): string {
  if (tool.loadTier === 'T1') {
    return `Tool '${tool.name}' is not wired — profile.tools.t1Policy must select it`;
  }
  if (tool.loadTier === 'T2') {
    return `Tool '${tool.name}' is not loaded — run profile.tools.t2Loader first`;
  }
  return `Tool '${tool.name}' is not visible this turn`;
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
      message: `Builtin '${tool.name}' is not enabled this turn`,
    };
    yield failureEvent(base, failure);
    return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
  }
  const failure: ToolFailure = {
    code: 'provider_native',
    message: `Tool '${tool.name}' is a provider builtin — execution is handled by the model provider, not the kernel`,
  };
  yield failureEvent(base, failure);
  return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
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
      message: `Tool '${name}' is not registered`,
    };
    yield failureEvent(base, failure);
    return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
  }
  if (tool.type === 'builtin') {
    if (!snapshot) {
      const failure: ToolFailure = {
        code: 'provider_native',
        message: `Tool '${name}' is a provider builtin and requires a turn tool snapshot`,
      };
      yield failureEvent(base, failure);
      return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
    }
    const fullCtx: ToolContext = { ...ctx, callId, profile };
    return yield* executeBuiltin(tool, fullCtx, base, snapshot);
  }
  if (profile.type === 'speech' || !profile.tools.allow.includes(name)) {
    const failure: ToolFailure = {
      code: 'not_allowed',
      message: `Tool '${name}' is not allowed on ${profile.id}`,
    };
    yield failureEvent(base, failure);
    return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
  }
  if (snapshot) {
    const continuing = isResumeContinuation(ctx.resume);
    if (!continuing && !snapshot.gated.includes(name)) {
      const failure: ToolFailure = {
        code: 'not_gated',
        message: `Tool '${name}' is not eligible on this turn (allow/path)`,
      };
      yield failureEvent(base, failure);
      return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
    }
    if (!snapshot.visible.includes(name)) {
      const skipLoadCheck = continuing && tool.loadTier === 'T0';
      if (!skipLoadCheck) {
        const failure: ToolFailure = {
          code: 'not_loaded',
          message: notLoadedMessage(tool),
        };
        yield failureEvent(base, failure);
        return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
      }
    }
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
    return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
  }

  if (tool.type === 'function') {
    const settlement = yield* executeFunction(tool, safeInput, fullCtx, base, snapshot, stages);
    if (settlement.modelResult) {
      const guarded = yield* guardResult(settlement.modelResult, provenance, policy, callableTools);
      return { ...settlement, modelResult: guarded };
    }
    return settlement;
  }

  // HTTP / MCP: declarative permission gate, then remote body (auth may gate).
  const permissionGate = checkPermission(
    tool.name,
    tool.permission,
    fullCtx.sessionPermissions,
    fullCtx.resume,
  );
  if (permissionGate) {
    yield gateEvent(base, permissionGate);
    return { gated: permissionGate, callNotStarted: true };
  }

  if (tool.type === 'http') {
    const httpResult = yield* executeHttpTool(tool, safeInput, fullCtx, base);
    if (httpResult === undefined) {
      // Auth gate or early failure — detect gate from last emitted path via remote.
      // Remote yields gate events; settlement without modelResult means gated or failed.
      return { callNotStarted: true };
    }
    const guarded = yield* guardResult(httpResult, provenance, policy, callableTools);
    const post = yield* settlePostTool(stages, {
      toolName: name,
      callId,
      input: safeInput,
      outputRaw: httpResult.data,
      outputModel: guarded,
    });
    return {
      modelResult: guarded,
      outputRaw: httpResult.data,
      ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
      ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
    };
  }
  if (tool.type === 'mcp') {
    const mcpResult = yield* executeMcpTool(tool, safeInput, fullCtx, base);
    if (mcpResult === undefined) {
      return { callNotStarted: true };
    }
    const guarded = yield* guardResult(mcpResult, provenance, policy, callableTools);
    const post = yield* settlePostTool(stages, {
      toolName: name,
      callId,
      input: safeInput,
      outputRaw: mcpResult.data,
      outputModel: guarded,
    });
    return {
      modelResult: guarded,
      outputRaw: mcpResult.data,
      ...(post.aborted !== undefined ? { aborted: post.aborted } : {}),
      ...(post.pendingInject?.length ? { pendingInject: post.pendingInject } : {}),
    };
  }

  const failure: ToolFailure = {
    code: 'unknown_tool',
    message: `Tool '${name}' has unsupported type`,
  };
  yield failureEvent(base, failure);
  return { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) };
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
