import {
  type ErrorKind,
  isLocalhostName,
  isPrivateOrLocalAddress,
  TheoremError,
} from '@theoremjs/agents';
import type { ClientError } from '@theoremjs/agents/host';

/** The route under a studio server's base that sends a page's tool request on. */
export const FORWARD_ROUTE = 'forward';
/** The answering host's status, on a forwarded reply. */
export const FORWARD_STATUS = 'x-theorem-forward-status';
/** The answering host's headers, as JSON pairs, on a forwarded reply. */
export const FORWARD_HEADERS = 'x-theorem-forward-headers';

/** Statuses a `Response` is refused a body on. */
const NO_BODY = new Set([204, 205, 304]);

/** One request a page's tool makes, as the page sends it to its server. */
export interface ForwardedRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body?: string;
}

/**
 * A `fetch` for the run's `fetch` option that sends each tool request through the studio's own
 * server at `endpoint`, and gives back the host's reply as the host sent it.
 * why: a page reaches only hosts that allow it by CORS, and an MCP server's preflight refuses the
 * headers MCP sends (`Mcp-Method`, `Mcp-Name`), so the call failed in the page and worked on the
 * server. The kernel checks each request against the run's network rules before it gets here.
 * A request to a local or private address goes straight from the page: it is on the builder's own
 * network, which the page reaches and a hosted server never does.
 */
export function forwardedFetch(endpoint: string): typeof fetch {
  return async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const target = new URL(url);
    const method = init.method ?? 'GET';
    // invariant: names the request without its query, which can hold a credential.
    const failed = (reason: string, kind: ErrorKind = 'network', cause?: unknown) =>
      new TheoremError(kind, `${method} ${target.origin}${target.pathname}: ${reason}`, {
        cause,
      }); // labels-exempt: internal diagnostic
    // why: a page's fetch rejects a CORS refusal and an unreachable host alike, with no reason.
    const sent = (request: Promise<Response>, unsent: string) =>
      request.catch((err: unknown) => {
        throw init.signal?.aborted ? err : failed(unsent, 'network', err);
      });
    if (isLocalhostName(target.hostname) || isPrivateOrLocalAddress(target.hostname)) {
      return sent(
        fetch(input, init),
        'the browser could not send it. The host is not running, or it does not let this page call it (CORS). The browser does not say which.',
      );
    }
    const asked: ForwardedRequest = {
      url,
      method,
      headers: [...new Headers(init.headers)],
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    };
    const response = await sent(
      fetch(`${endpoint}/${FORWARD_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(asked),
        signal: init.signal ?? null,
      }),
      `the studio's server at ${endpoint} could not be reached to send it.`,
    );
    const status = response.headers.get(FORWARD_STATUS);
    if (status === null) {
      const refused = (await response.json().catch(() => ({}))) as Partial<ClientError>;
      throw failed(
        refused.error || `the studio's server answered ${response.status}`,
        refused.errorKind ?? 'network',
      );
    }
    const headers = JSON.parse(response.headers.get(FORWARD_HEADERS) ?? '[]') as [string, string][];
    const code = Number(status);
    return new Response(NO_BODY.has(code) ? null : response.body, { status: code, headers });
  };
}
