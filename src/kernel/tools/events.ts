import type { z } from 'zod';
import { throwIfAborted } from '../../guardrails/error.ts';
import { assertSafeUrl } from '../../guardrails/network.ts';
import { resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import type { NetworkGuardrailSpec } from '../../guardrails/types.ts';
import { type Source, sourceSchema } from '../turn-events.ts';
import type { TurnEvent, TurnEventOf } from '../types.ts';
import { isRecord } from '../util/record.ts';
import { formatToolFailureForModel, formatToolResult } from './model-text.ts';
import type { ToolCallRequest, ToolContext, ToolFailure, ToolPhaseEvent } from './types.ts';

export type ToolCallBase = Pick<ToolPhaseEvent, 'name' | 'callId'>;

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ToolPhasePatch = DistributiveOmit<ToolPhaseEvent, keyof ToolCallBase | 'at'>;

export function toolEvent(base: ToolCallBase, patch: ToolPhasePatch): TurnEventOf<'tool'> {
  return {
    type: 'tool',
    tool: { ...patch, name: base.name, callId: base.callId, at: Date.now() },
  };
}

/** `readBack` is passed when the call's result guard already wrote the model's text. */
export function failureEvent(
  base: ToolCallBase,
  failure: ToolFailure,
  readBack: string = formatToolResult(formatToolFailureForModel(failure)),
): TurnEventOf<'tool'> {
  return toolEvent(base, { phase: 'error', failure, readBack });
}

/** The first event of every call. */
export function toolCallRequestEvent(
  base: ToolCallBase,
  args: Record<string, unknown>,
  { thoughtSignature, stepId }: Pick<ToolCallRequest, 'thoughtSignature' | 'stepId'> = {},
): TurnEventOf<'tool'> {
  return {
    type: 'tool',
    tool: {
      name: base.name,
      callId: base.callId,
      arguments: args,
      ...(thoughtSignature ? { thoughtSignature } : {}),
      ...(stepId ? { stepId } : {}),
    },
  };
}

/** Unique: readers join a call's events by it. */
export function newCallId(name: string): string {
  return `call_${name}_${crypto.randomUUID()}`;
}

export function toolCallArguments(safeInput: unknown): Record<string, unknown> {
  if (safeInput === undefined) return {};
  return isRecord(safeInput) ? safeInput : { value: safeInput };
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sourcesInvalid(base: ToolCallBase, message: string): TurnEventOf<'tool'> {
  return toolEvent(base, {
    phase: 'warning',
    warning: { code: 'sources_invalid', message, severity: 'warning' },
  });
}

export function* sourceEvents(
  base: ToolCallBase,
  sources: (output: unknown) => Source[],
  output: unknown,
): Generator<TurnEvent> {
  let listed: unknown;
  try {
    listed = sources(output);
  } catch (err) {
    yield sourcesInvalid(base, `sources threw: ${messageOf(err)}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return;
  }
  if (!Array.isArray(listed)) {
    yield sourcesInvalid(base, 'sources must return an array'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return;
  }
  const cited: Source[] = [];
  const invalid: string[] = [];
  listed.forEach((entry: unknown, index) => {
    const parsed = sourceSchema.safeParse(entry);
    if (parsed.success) cited.push(parsed.data);
    else
      invalid.push(
        `[${String(index)}] ${parsed.error.issues.map((i) => `${i.path.join('.') || 'source'}: ${i.message}`).join('; ')}`,
      );
  });
  if (invalid.length > 0) {
    yield sourcesInvalid(base, `sources not cited: ${invalid.join(' | ')}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (cited.length > 0) yield { type: 'citation', sources: cited, callId: base.callId };
}

/** `{ ok: false }` comes after the failure event is emitted, so callers only bail. */
export function* startToolExecution<T>(
  tool: { input: z.ZodType<T> },
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
): Generator<TurnEvent, { ok: true; data: T } | { ok: false }> {
  const edited = ctx.resume?.edited;
  yield toolEvent(base, {
    phase: 'running',
    ...(edited ? { edited: { from: edited.from, to: toolCallArguments(rawInput) } } : {}),
  });
  throwIfAborted(ctx.signal);
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    yield failureEvent(base, {
      code: 'invalid_input',
      kind: 'bad_response',
      message: 'Tool input validation failed', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      details: parsed.error.flatten(),
    });
    return { ok: false };
  }
  return { ok: true, data: parsed.data };
}

export function* networkBlocked(err: unknown): Generator<TurnEvent, ToolFailure> {
  yield {
    type: 'guardrail',
    guardrail: {
      stage: 'network',
      trust: 'untrusted',
      action: 'block',
      hits: [{ rule: 'network.blocked', severity: 'high' }],
    },
  };
  return { code: 'network_blocked', kind: 'blocked', message: messageOf(err) };
}

/** Shared by HTTP and MCP so they cannot diverge on what SSRF enforcement means. */
export function* guardToolTarget(
  url: string,
  ctx: ToolContext,
): Generator<TurnEvent, { ok: true; url: URL } | { ok: false; failure: ToolFailure }> {
  try {
    return { ok: true, url: assertSafeUrl(url, toolNetworkPolicy(ctx)) };
  } catch (err) {
    return { ok: false, failure: yield* networkBlocked(err) };
  }
}

export function toolNetworkPolicy(ctx: ToolContext): NetworkGuardrailSpec | undefined {
  return resolveGuardrailPolicy(ctx.profile.guardrails).network;
}
