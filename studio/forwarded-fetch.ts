import { isLocalhostName, isPrivateOrLocalAddress, TheoremError } from '@theoremjs/agents';
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
    const { hostname } = new URL(url);
    if (isLocalhostName(hostname) || isPrivateOrLocalAddress(hostname)) return fetch(input, init);
    const asked: ForwardedRequest = {
      url,
      method: init.method ?? 'GET',
      headers: [...new Headers(init.headers)],
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    };
    const response = await fetch(`${endpoint}/${FORWARD_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(asked),
      signal: init.signal ?? null,
    });
    const status = response.headers.get(FORWARD_STATUS);
    if (status === null) {
      const failed = (await response.json().catch(() => ({}))) as Partial<ClientError>;
      throw new TheoremError(
        failed.errorKind ?? 'network',
        failed.error || `the studio's server answered ${response.status}`,
      ); // labels-exempt: internal diagnostic
    }
    const headers = JSON.parse(response.headers.get(FORWARD_HEADERS) ?? '[]') as [string, string][];
    const code = Number(status);
    return new Response(NO_BODY.has(code) ? null : response.body, { status: code, headers });
  };
}
