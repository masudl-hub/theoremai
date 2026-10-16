import { TheoremError } from '../../guardrails/error.ts';
import {
  failureEvent,
  newCallId,
  type ToolCallBase,
  toolCallRequestEvent,
} from '../../kernel/tools/events.ts';
import type { ToolCallRequest } from '../../kernel/tools/types.ts';
import type { ProviderEvent } from '../../kernel/types.ts';
import { isRecord } from '../../kernel/util/record.ts';

/**
 * Adapters never invent a history call id or name: a provider that needs a
 * missing one rejects the request, and that error is the answer.
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

export function historyToolArguments(raw: unknown): Record<string, unknown> {
  const parsed = parseToolArgumentsObject(raw);
  if (!parsed.ok) {
    throw new TheoremError('bad_response', parsed.error);
  }
  return parsed.value;
}

/** A call sent without an id gets one, so its request and failure events join. */
export function toolCallEvents(
  call: Pick<ToolCallRequest, 'name' | 'thoughtSignature' | 'stepId' | 'stepCallCount'> & {
    id?: string;
  },
  rawArguments: unknown,
): ProviderEvent[] {
  const name = call.name.trim();
  const base = { name, callId: call.id ?? newCallId(name) };
  const request = {
    thoughtSignature: call.thoughtSignature,
    stepId: call.stepId,
    stepCallCount: call.stepCallCount,
  };
  if (!name) {
    return malformedToolCall(base, 'function call is missing a name', rawArguments, request);
  }
  const parsed = parseToolArgumentsObject(rawArguments);
  if (!parsed.ok) {
    return malformedToolCall(base, parsed.error, parsed.raw, request);
  }
  return [toolCallRequestEvent(base, parsed.value, request)];
}

/** Keeps the thought signature: the model still reads the failed call's result back. */
export function malformedToolCall(
  base: ToolCallBase,
  message: string,
  raw: unknown,
  request: Pick<ToolCallRequest, 'thoughtSignature' | 'stepId' | 'stepCallCount'> = {},
): ProviderEvent[] {
  return [
    toolCallRequestEvent(base, {}, request),
    failureEvent(base, {
      code: 'malformed_arguments',
      kind: 'bad_response',
      message,
      details: { raw },
    }),
  ];
}
