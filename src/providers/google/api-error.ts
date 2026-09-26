/**
 * A Gemini API error as a `TheoremError`: the `error` object Interactions
 * (SSE `error` events, non-OK bodies) and Live (error frames) both send,
 * `{ error: { code, message, status } }`.
 *
 * @module
 */

import { type ErrorKind, kindOfHttpStatus, TheoremError } from '../../guardrails/error.ts';
import { asRecord } from '../../kernel/engine/record.ts';

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

/** Kinds for the named codes Google puts on errors inside an Interactions stream. */
const STREAM_ERROR_KINDS: Readonly<Record<string, ErrorKind>> = {
  rate_limit_exceeded: 'rate_limit',
};

/**
 * The error a record's `error` object states, or null when it has none. The
 * kind comes from `code`: an HTTP status, or a stream error's named code. An
 * error with neither names no kind of its own, so it is a response THEOREM
 * cannot use (`bad_response`).
 */
export function readGeminiApiError(record: Record<string, unknown>): TheoremError | null {
  const error = asRecord(record.error);
  if (!error) {
    return null;
  }
  const { code, message, status } = error;
  const kind =
    typeof code === 'number' && code >= HTTP_STATUS_MIN && code <= HTTP_STATUS_MAX
      ? kindOfHttpStatus(code)
      : ((typeof code === 'string' ? STREAM_ERROR_KINDS[code] : undefined) ?? 'bad_response');
  if (typeof message !== 'string' || message.length === 0) {
    return new TheoremError(kind, 'Gemini returned an error.');
  }
  return new TheoremError(kind, typeof status === 'string' ? `${status}: ${message}` : message);
}

/** A non-OK response as an error: its body's error, else the raw body, else the status. The kind is the status's. */
export async function readNonOkError(response: Response): Promise<TheoremError> {
  const kind = kindOfHttpStatus(response.status);
  const text = await response.text().catch(() => '');
  if (!text.trim()) {
    return new TheoremError(kind, `HTTP ${response.status}`);
  }
  const parsed = parseRecord(text);
  const stated = parsed ? readGeminiApiError(parsed) : null;
  return new TheoremError(kind, stated?.message ?? `Gemini HTTP ${response.status}: ${text}`);
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}
