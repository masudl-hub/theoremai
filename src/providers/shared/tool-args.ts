/**
 * Shared tool-argument JSON parsing for all provider adapters.
 *
 * Malformed or non-object JSON is a hard failure — never invent `{}` or `{ _raw }`.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import {
  failureEvent,
  newCallId,
  type ToolCallBase,
  toolCallRequestEvent,
} from '../../kernel/tools/events.ts';
import type { ProviderEvent } from '../../kernel/types.ts';
import { isRecord } from '../../kernel/util/record.ts';

/**
 * Tool identity fields (call id, tool name) from host history, kept only where
 * the message carries them. Adapters never invent an id or name: a provider
 * that needs a missing one rejects the request, and that error is the answer.
 */
export function historyToolIdentity(
  fields: Record<string, string | undefined>,
): Record<string, string> {
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) present[key] = value;
  }
  return present;
}

export type ParsedToolArguments =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; raw: string };

/** Parse provider / history tool-call arguments. */
export function parseToolArgumentsObject(raw: unknown): ParsedToolArguments {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: true, value: {} };
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        return { ok: true, value: parsed };
      }
      return {
        ok: false,
        error: 'tool arguments JSON must be an object',
        raw,
      };
    } catch {
      return {
        ok: false,
        error: 'malformed tool arguments JSON',
        raw,
      };
    }
  }
  if (isRecord(raw)) {
    return { ok: true, value: raw };
  }
  if (raw === undefined || raw === null) {
    return { ok: true, value: {} };
  }
  return {
    ok: false,
    error: 'tool arguments must be a JSON object',
    raw: String(raw),
  };
}

/**
 * Tool-call arguments from host history, rebuilt for a provider request.
 * Malformed or non-object JSON throws `TheoremError`.
 */
export function historyToolArguments(raw: unknown): Record<string, unknown> {
  const parsed = parseToolArgumentsObject(raw);
  if (!parsed.ok) {
    throw new TheoremError('bad_response', parsed.error);
  }
  return parsed.value;
}

/**
 * A model's tool call as a provider sent it: the call, then — when the name
 * or arguments are unusable — its failure carrying what arrived. A call sent
 * without an id gets one, so its events join.
 */
export function toolCallEvents(
  call: { id?: string; name: string; thoughtSignature?: string },
  rawArguments: unknown,
): ProviderEvent[] {
  const name = call.name.trim();
  const base = { name, callId: call.id ?? newCallId(name) };
  if (!name) {
    return malformedToolCall(
      base,
      'function call is missing a name',
      rawArguments,
      call.thoughtSignature,
    );
  }
  const parsed = parseToolArgumentsObject(rawArguments);
  if (!parsed.ok) {
    return malformedToolCall(base, parsed.error, parsed.raw, call.thoughtSignature);
  }
  return [toolCallRequestEvent(base, parsed.value, { thoughtSignature: call.thoughtSignature })];
}

/**
 * A call whose name or arguments are unusable: the call with none, then its
 * failure. It keeps its thought signature: the model still reads its result back.
 */
export function malformedToolCall(
  base: ToolCallBase,
  message: string,
  raw: unknown,
  thoughtSignature?: string,
): ProviderEvent[] {
  return [
    toolCallRequestEvent(base, {}, { thoughtSignature }),
    failureEvent(base, {
      code: 'malformed_arguments',
      kind: 'bad_response',
      message,
      details: { raw },
    }),
  ];
}
