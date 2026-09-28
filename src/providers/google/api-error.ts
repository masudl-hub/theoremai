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

/**
 * The HTTP status behind each named code Google puts on an Interactions error
 * (https://ai.google.dev/gemini-api/docs/api-errors). A code it does not list
 * is the snake_case name of the HTTP status, so those names are here too.
 */
const NAMED_CODE_STATUS: Readonly<Record<string, number>> = {
  invalid_request: 400,
  failed_precondition: 400,
  parameter_unknown: 400,
  authentication: 401,
  payment_required: 402,
  permission_denied: 403,
  not_found: 404,
  model_not_found: 404,
  already_exists: 409,
  aborted: 409,
  out_of_range: 416,
  rate_limit_exceeded: 429,
  quota_exceeded: 429,
  too_many_requests: 429,
  api_error: 500,
  unimplemented: 501,
  service_unavailable: 503,
  deadline_exceeded: 504,
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  method_not_allowed: 405,
  request_timeout: 408,
  conflict: 409,
  payload_too_large: 413,
  unprocessable_entity: 422,
  internal_server_error: 500,
  not_implemented: 501,
  bad_gateway: 502,
  gateway_timeout: 504,
};

/** Codes for a generation Google blocked: its safety filters held the reply back. */
const BLOCKED_CODES: ReadonlySet<string> = new Set([
  'safety',
  'recitation',
  'language',
  'prohibited_content',
  'spii',
  'blocklist',
  'image_safety',
  'image_prohibited_content',
  'image_recitation',
  'image_other',
  'content_blocked',
]);

/**
 * The kind a named code states. `cancelled` (499) is the request stopped on
 * THEOREM's side. The generation error codes (`malformed_function_call`,
 * `no_image`, …) and any code Google adds later are a reply THEOREM cannot use.
 */
function kindOfNamedCode(code: string): ErrorKind {
  if (code === 'cancelled') return 'cancelled';
  if (BLOCKED_CODES.has(code)) return 'safety';
  const status = NAMED_CODE_STATUS[code];
  return status === undefined ? 'bad_response' : kindOfHttpStatus(status);
}

/**
 * The error a record's `error` object states, or null when it has none. The
 * kind comes from `code`: an HTTP status, or a named code (`service_unavailable`
 * is `unavailable`, `safety` is `safety`). An error with neither, or a named
 * code Google has not documented, is a response THEOREM cannot use
 * (`bad_response`).
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
      : typeof code === 'string'
        ? kindOfNamedCode(code)
        : 'bad_response';
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
