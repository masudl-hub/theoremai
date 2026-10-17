import { type ErrorKind, kindOfHttpStatus, TheoremError } from '../../guardrails/error.ts';
import { asRecord } from '../../kernel/engine/record.ts';

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

/**
 * Google refuses a bad key as a 400 `INVALID_ARGUMENT`, so the status reads as
 * a request THEOREM cannot make; the `ErrorInfo` reason is what says it is the
 * key. An expired key carries the same reason.
 */
const AUTH_REASONS: ReadonlySet<string> = new Set(['API_KEY_INVALID']);

/** Whether an error's `details` name a key Google refused. */
function refusesKey(details: unknown): boolean {
  return (
    Array.isArray(details) &&
    details.some((detail) => {
      const reason = asRecord(detail)?.reason;
      return typeof reason === 'string' && AUTH_REASONS.has(reason);
    })
  );
}

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

/** Codes for a generation Google's safety filters held back. */
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
 * `cancelled` (499) is the request stopped on THEOREM's side. Generation error
 * codes (`malformed_function_call`, `no_image`, …) and any code Google adds later
 * are `bad_response`.
 */
function kindOfNamedCode(code: string): ErrorKind {
  if (code === 'cancelled') return 'cancelled';
  if (BLOCKED_CODES.has(code)) return 'safety';
  const status = NAMED_CODE_STATUS[code];
  return status === undefined ? 'bad_response' : kindOfHttpStatus(status);
}

/**
 * Interactions (SSE `error` rows, non-OK bodies) and Live (error frames) both send
 * `{ error: { code, message, status } }`; `code` is an HTTP status or a named code.
 */
export function readGeminiApiError(record: Record<string, unknown>): TheoremError | null {
  const error = asRecord(record.error);
  if (!error) {
    return null;
  }
  const { code, message, status, details } = error;
  const kind: ErrorKind = refusesKey(details)
    ? 'auth'
    : typeof code === 'number' && code >= HTTP_STATUS_MIN && code <= HTTP_STATUS_MAX
      ? kindOfHttpStatus(code)
      : typeof code === 'string'
        ? kindOfNamedCode(code)
        : 'bad_response';
  if (typeof message !== 'string' || message.length === 0) {
    return new TheoremError(kind, 'Gemini returned an error.');
  }
  return new TheoremError(kind, typeof status === 'string' ? `${status}: ${message}` : message);
}

/** The kind is the HTTP status's, unless the body names a refused key. */
export async function readNonOkError(response: Response): Promise<TheoremError> {
  const kind = kindOfHttpStatus(response.status);
  const text = await response.text().catch(() => '');
  if (!text.trim()) {
    return new TheoremError(kind, `HTTP ${response.status}`);
  }
  const parsed = parseRecord(text);
  const stated = parsed ? readGeminiApiError(parsed) : null;
  return new TheoremError(
    stated?.kind === 'auth' ? 'auth' : kind,
    stated?.message ?? `Gemini HTTP ${response.status}: ${text}`,
  );
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}
