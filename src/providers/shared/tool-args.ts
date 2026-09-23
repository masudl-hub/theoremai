/**
 * Shared tool-argument JSON parsing for all provider adapters.
 *
 * Malformed or non-object JSON is a hard failure — never invent `{}` or `{ _raw }`.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';

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
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
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
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ok: true, value: raw as Record<string, unknown> };
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
    throw new TheoremError(parsed.error);
  }
  return parsed.value;
}
