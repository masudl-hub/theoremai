/**
 * Shared tool-argument JSON parsing for all provider adapters.
 *
 * Malformed or non-object JSON is a hard failure — never invent `{}` or `{ _raw }`.
 *
 * @module
 */

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
        raw: trimmed,
      };
    } catch {
      return {
        ok: false,
        error: 'malformed tool arguments JSON',
        raw: trimmed,
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
