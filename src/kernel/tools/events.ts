/**
 * Tool event shapes and the preamble every executable tool path shares.
 *
 * Function, declarative HTTP, and remote MCP tools all announce themselves,
 * validate their input, and — for the remote kinds — clear their target against
 * the profile's SSRF policy. Keeping that here means the three paths cannot drift,
 * and it holds the event constructors both `execute.ts` and `remote.ts` need
 * without either importing the other.
 *
 * @module
 */

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

/** Identifying fields repeated on every event for one tool call. */
export type ToolCallBase = Pick<ToolPhaseEvent, 'name' | 'callId'>;

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** One phase and its fields; `toolEvent` adds the call's identity and `at`. */
export type ToolPhasePatch = DistributiveOmit<ToolPhaseEvent, keyof ToolCallBase | 'at'>;

/** The one constructor of tool phase events: it stamps `at`. */
export function toolEvent(base: ToolCallBase, patch: ToolPhasePatch): TurnEventOf<'tool'> {
  return {
    type: 'tool',
    tool: { ...patch, name: base.name, callId: base.callId, at: Date.now() },
  };
}

/**
 * A call's failure, with `readBack`: the text the model reads for it. That is
 * the failure as the kernel words it, unless the call's result guard already
 * wrote it (`settleToolCall`).
 */
export function failureEvent(
  base: ToolCallBase,
  failure: ToolFailure,
  readBack: string = formatToolResult(formatToolFailureForModel(failure)),
): TurnEventOf<'tool'> {
  return toolEvent(base, { phase: 'error', failure, readBack });
}

/** The model's call, as a provider emits it: the first event of every call. */
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

/** A call id for a call the provider sent without one. Unique: readers join a call's events by it. */
export function newCallId(name: string): string {
  return `call_${name}_${crypto.randomUUID()}`;
}

/** Tool arguments as an object, the shape tool events carry: no input is no arguments; a bare value is `{ value }`. */
export function toolCallArguments(safeInput: unknown): Record<string, unknown> {
  if (safeInput === undefined) return {};
  return isRecord(safeInput) ? safeInput : { value: safeInput };
}

/** Failure text for a thrown value, without leaking a stack. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sourcesInvalid(base: ToolCallBase, message: string): TurnEventOf<'tool'> {
  return toolEvent(base, {
    phase: 'warning',
    warning: { code: 'sources_invalid', message, severity: 'warning' },
  });
}

/**
 * What a completed call's output cites, from its tool's `sources`: a `citation`
 * with the call's `callId`, and one `sources_invalid` warning naming every
 * source that failed `sourceSchema` (those are not cited) or the throw.
 */
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

/**
 * Announce the call and validate its input.
 *
 * Returns `{ ok: false }` after emitting the failure event, so callers bail
 * without re-deciding what an invalid input means.
 */
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

/**
 * A remote request refused by the network policy — its target or a redirect
 * hop: the guardrail event, and the failure the call settles with.
 */
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

/**
 * Clear a remote target against the profile's network policy, so HTTP and
 * MCP cannot diverge on what SSRF enforcement means. A refused target comes
 * back as the failure to settle with; the settlement emits the terminal event.
 */
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

/** The network policy remote tools and their OAuth refreshes clear. */
export function toolNetworkPolicy(ctx: ToolContext): NetworkGuardrailSpec | undefined {
  return resolveGuardrailPolicy(ctx.profile.guardrails).network;
}
