/**
 * Shared tool execution core for model-initiated and host-initiated calls.
 *
 * @module
 */

import type { z } from 'zod';
import { throwIfAborted } from '../../guardrails/error.ts';
import { sanitizeText } from '../../guardrails/sanitize.ts';
import type { Profile, TurnEvent } from '../types.ts';
import { getTool } from './registry.ts';
import { promoteLoadedTools } from './resolve.ts';
import type {
  FunctionToolDef,
  InvokeToolResume,
  ModelToolResult,
  ToolCallEvent,
  ToolContext,
  ToolFailure,
  ToolPause,
  ToolPermission,
  ToolStreamEvent,
  TurnToolSnapshot,
} from './types.ts';

function isStreamHandler(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    Object.prototype.toString.call(handler) === '[object AsyncGeneratorFunction]'
  );
}

export function isResumeContinuation(resume?: InvokeToolResume): boolean {
  return resume?.value !== undefined || resume?.granted === true;
}

export function isToolPause(value: ToolFailure | ToolPause): value is ToolPause {
  return (
    'kind' in value &&
    (value.kind === 'interactive' || value.kind === 'confirmation' || value.kind === 'permission')
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
): ToolPause | null {
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
      input: {},
    };
  }
  if (permissionGranted(toolName, sessionPermissions)) {
    return null;
  }
  return {
    kind: 'permission',
    tool: toolName,
    permission,
    input: {},
  };
}

function toolEvent(
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  patch: Partial<ToolCallEvent>,
): TurnEvent {
  return {
    type: 'tool',
    tool: { ...base, ...patch },
  };
}

function failureEvent(
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  failure: ToolFailure,
): TurnEvent {
  return toolEvent(base, { phase: 'error', failure });
}

export function projectForModel(tool: FunctionToolDef, output: unknown): ModelToolResult {
  if (tool.exposeToModel === false) {
    return { finding: 'Completed.' };
  }
  const finding =
    typeof output === 'object' && output !== null && 'finding' in output
      ? String((output as { finding?: unknown }).finding)
      : JSON.stringify(output);
  return {
    finding: sanitizeText(finding),
    data: output,
  };
}

/** Format model-facing tool output for provider history continuation. */
export function formatToolResult(result: ModelToolResult): string {
  if (result.data !== undefined) {
    return sanitizeText(`${result.finding}\n${JSON.stringify(result.data)}`);
  }
  return sanitizeText(result.finding);
}

/** Format a tool failure for provider history — structured so the model (or host) sees the code. */
export function formatToolFailureForModel(failure: ToolFailure): ModelToolResult {
  return {
    finding: `Tool error (${failure.code}): ${failure.message}`,
    data: {
      ok: false,
      code: failure.code,
      message: failure.message,
      ...(failure.details !== undefined ? { details: failure.details } : {}),
    },
  };
}

export function* startToolExecution<T>(
  tool: { input: z.ZodType<T> },
  rawInput: unknown,
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
): Generator<TurnEvent, { ok: true; data: T } | { ok: false }> {
  yield toolEvent(base, { phase: 'running' });
  throwIfAborted(ctx.signal);
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    yield failureEvent(base, {
      code: 'invalid_input',
      message: 'Tool input validation failed',
      details: parsed.error.flatten(),
    });
    return { ok: false };
  }
  return { ok: true, data: parsed.data };
}

export async function* executeFunction(
  tool: FunctionToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  snapshot?: TurnToolSnapshot,
): AsyncGenerator<TurnEvent, ModelToolResult | undefined> {
  const parsed = yield* startToolExecution(tool, rawInput, ctx, base);
  if (!parsed.ok) return undefined;
  const input = parsed.data;

  const permissionPause = checkPermission(
    tool.name,
    tool.permission,
    ctx.sessionPermissions,
    ctx.resume,
  );
  if (permissionPause) {
    permissionPause.input = input;
    yield toolEvent(base, { phase: 'pause', pause: permissionPause });
    return undefined;
  }

  throwIfAborted(ctx.signal);

  if (tool.canExecute) {
    try {
      const allowed = await tool.canExecute(input, ctx);
      if (!allowed) {
        yield failureEvent(base, {
          code: 'not_authorized',
          message: 'Tool execution not authorized',
        });
        return undefined;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield failureEvent(base, {
        code: 'not_authorized',
        message: `Authorization failed for '${tool.name}': ${msg}`,
      });
      return undefined;
    }
  }

  if (tool.preflight) {
    const pre = await tool.preflight(input, ctx);
    if (pre) {
      if (isToolPause(pre)) {
        const pausePayload: ToolPause = { ...pre, input: pre.input ?? input };
        yield toolEvent(base, { phase: 'pause', pause: pausePayload });
        return undefined;
      }
      yield failureEvent(base, pre);
      return undefined;
    }
  }

  if (tool.interactive && ctx.resume?.value === undefined) {
    const render = tool.interactive.render(input);
    const interactivePause: ToolPause = {
      kind: 'interactive',
      tool: tool.name,
      render,
      input,
    };
    yield toolEvent(base, { phase: 'pause', pause: interactivePause });
    return undefined;
  }

  throwIfAborted(ctx.signal);
  try {
    const output = yield* runHandler(tool.handler, input, ctx, base);
    if (output === undefined) {
      yield failureEvent(base, { code: 'invalid_output', message: 'Handler returned no output' });
      return undefined;
    }
    const checked = tool.output.safeParse(output);
    if (!checked.success) {
      yield failureEvent(base, {
        code: 'invalid_output',
        message: 'Tool output validation failed',
        details: checked.error.flatten(),
      });
      return undefined;
    }

    let finalOutput: unknown = checked.data;
    if (ctx.profile.type !== 'speech' && ctx.profile.tools.t2Loader === tool.name) {
      if (!snapshot) {
        yield failureEvent(base, {
          code: 'invalid_output',
          message: `tools.t2Loader '${tool.name}' requires a turn tool snapshot`,
        });
        return undefined;
      }
      const loaded = extractLoadedIds(checked.data);
      if (!loaded) {
        yield failureEvent(base, {
          code: 'invalid_output',
          message: `T2 loader '${tool.name}' must return { loaded: string[] }`,
        });
        return undefined;
      }
      const { promoted, failure: promoteFailure } = promoteLoadedTools(
        snapshot,
        loaded,
        ctx.profile,
      );
      if (promoteFailure) {
        yield failureEvent(base, promoteFailure);
        return undefined;
      }
      finalOutput = { ...(checked.data as Record<string, unknown>), loaded: promoted };
      const rechecked = tool.output.safeParse(finalOutput);
      if (!rechecked.success) {
        yield failureEvent(base, {
          code: 'invalid_output',
          message: 'T2 loader output validation failed after promotion',
          details: rechecked.error.flatten(),
        });
        return undefined;
      }
      finalOutput = rechecked.data;
    }

    const modelResult = projectForModel(tool, finalOutput);
    yield toolEvent(base, { phase: 'complete', output: finalOutput });
    return modelResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield failureEvent(base, { code: 'handler_error', message: msg });
    return undefined;
  }
}

export function notLoadedMessage(tool: FunctionToolDef): string {
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
): AsyncGenerator<TurnEvent, ModelToolResult | undefined> {
  yield toolEvent(base, { phase: 'running' });
  throwIfAborted(ctx.signal);
  if (!snapshot.builtins.includes(tool.name)) {
    yield failureEvent(base, {
      code: 'not_loaded',
      message: `Builtin '${tool.name}' is not enabled this turn`,
    });
    return undefined;
  }
  yield failureEvent(base, {
    code: 'provider_native',
    message: `Tool '${tool.name}' is a provider builtin — execution is handled by the model provider, not the kernel`,
  });
  return undefined;
}

export async function* executeRegisteredTool(args: {
  profile: Profile;
  name: string;
  input: unknown;
  callId: string;
  ctx: Omit<ToolContext, 'callId' | 'profile'>;
  snapshot?: TurnToolSnapshot;
}): AsyncGenerator<TurnEvent, ModelToolResult | undefined> {
  const { profile, name, input, callId, ctx, snapshot } = args;
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
    yield failureEvent(base, { code: 'unknown_tool', message: `Tool '${name}' is not registered` });
    return undefined;
  }
  if (tool.type === 'builtin') {
    if (!snapshot) {
      yield failureEvent(base, {
        code: 'provider_native',
        message: `Tool '${name}' is a provider builtin and requires a turn tool snapshot`,
      });
      return undefined;
    }
    const fullCtx: ToolContext = { ...ctx, callId, profile };
    return yield* executeBuiltin(tool, fullCtx, base, snapshot);
  }
  if (profile.type === 'speech' || !profile.tools.allow.includes(name)) {
    yield failureEvent(base, {
      code: 'not_allowed',
      message: `Tool '${name}' is not allowed on ${profile.id}`,
    });
    return undefined;
  }
  if (snapshot) {
    const continuing = isResumeContinuation(ctx.resume);
    if (!continuing && !snapshot.gated.includes(name)) {
      yield failureEvent(base, {
        code: 'not_gated',
        message: `Tool '${name}' is not eligible on this turn (allow/path)`,
      });
      return undefined;
    }
    if (!snapshot.visible.includes(name)) {
      const skipLoadCheck = continuing && tool.loadTier === 'T0';
      if (!skipLoadCheck) {
        yield failureEvent(base, {
          code: 'not_loaded',
          message: notLoadedMessage(tool),
        });
        return undefined;
      }
    }
  }
  const fullCtx: ToolContext = { ...ctx, callId, profile };

  return yield* executeFunction(tool, safeInput, fullCtx, base, snapshot);
}

export function newCallId(name: string): string {
  return `call_${name}_${Date.now()}`;
}
