import { type ErrorKind, errorKind } from '../guardrails/error.ts';

/** HTTP status for a success. */
const HTTP_OK = 200;
/** HTTP status for an unknown route. */
const HTTP_NOT_FOUND = 404;
/** HTTP status for a method the route does not take. */
const HTTP_METHOD = 405;
/** HTTP status for a request refused because the host is busy. */
const HTTP_BUSY = 429;

const STATUS_BY_KIND: Readonly<Record<ErrorKind, number>> = {
  config: 500,
  request: 400,
  input: 422,
  action: 403,
  auth: 401,
  rate_limit: HTTP_BUSY,
  unsupported: 422,
  unavailable: 503,
  bad_response: 502,
  network: 502,
  timeout: 504,
  safety: 422,
  blocked: 403,
  declined: 409,
  failed: 502,
  // why: Client closed request (nginx convention): the caller went away.
  cancelled: 499,
  internal: 500,
};

/** A JSON response with the status and the CORS headers. */
function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/** The HTTP status for a caught error, by its kind. */
function caughtStatus(err: unknown): number {
  return STATUS_BY_KIND[errorKind(err)];
}

export { caughtStatus, HTTP_BUSY, HTTP_METHOD, HTTP_NOT_FOUND, HTTP_OK, json };
