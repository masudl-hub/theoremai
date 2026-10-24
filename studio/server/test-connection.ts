/**
 * Asks a draft HTTP or MCP tool's endpoint one request, through the kernel's network guard, so the
 * builder sees whether it answers before a model calls it.
 *
 * @module
 */
import {
  buildHttpToolTarget,
  type CredentialQuery,
  credentialPlacement,
  errorKind,
  fetchGuarded,
  isUnsupportedMcpProtocolError,
  MCP_PROTOCOL_VERSIONS,
  mcpRequestMeta,
  type NetworkGuardrailSpec,
  parseMcpRpcResponse,
  type ResolveHost,
  TheoremError,
  withCredentialQuery,
  z,
} from '@theoremjs/agents';
import { caughtStatus, clientError } from '@theoremjs/agents/host';
import type { HttpMethod } from '@theoremjs/agents/schema';
import { readBody } from '@theoremjs/web/server';

/** What a test's request is checked against: the network guardrail it keeps to, and the resolver that finds where a name points. */
type ProbeGuard = { policy?: NetworkGuardrailSpec; resolveHost?: ResolveHost };

/** A draft's network guardrail, as the screen sends it beside the test. */
const draftNetworkSchema = z
  .object({
    allowPrivateNetworks: z.boolean().optional(),
    allowedHosts: z.array(z.string().min(1).max(253)).max(64).optional(),
    allowedSchemes: z.array(z.string().min(1).max(32)).max(8).optional(),
  })
  .strict()
  .optional();

type AuthProbe = {
  slot?: string;
  type?: 'bearer' | 'api_key' | 'oauth2';
  headerName?: string;
  headerPrefix?: string;
  queryParam?: string;
};

type TestConnectionRequest =
  | {
      type: 'http';
      endpoint: string;
      method?: string;
      headers?: Record<string, string>;
      pathParams?: string[];
      queryParams?: string[];
      bodyParam?: string;
      sampleInput?: Record<string, unknown>;
      auth?: AuthProbe;
      testCredential?: string;
    }
  | {
      type: 'mcp';
      serverUrl: string;
      mcpToolName?: string;
      headers?: Record<string, string>;
      auth?: AuthProbe;
      testCredential?: string;
    };

interface McpRpcResponse {
  jsonrpc?: string;
  result?: {
    tools?: Array<{ name: string; description?: string }>;
    [key: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
}

function elapsedSince(start: number): number {
  return Date.now() - start;
}

/** Where the test credential goes: wherever the kernel would put the tool's own. */
function probeCredential(
  auth: AuthProbe | undefined,
  testCredential: string | undefined,
): { headers: Record<string, string>; query?: CredentialQuery } {
  if (!auth?.type || !testCredential) return { headers: {} };
  // A pasted OAuth token is sent as the bearer token it is.
  const credential =
    auth.type === 'api_key'
      ? ({ type: 'api_key', key: testCredential } as const)
      : ({ type: 'bearer', token: testCredential } as const);
  return credentialPlacement(
    {
      headerName: auth.headerName?.trim() || undefined,
      headerPrefix: auth.headerPrefix,
      queryParam: auth.queryParam?.trim() || undefined,
    },
    credential,
  );
}

function isRedirect(res: Response): boolean {
  return res.status >= 300 && res.status < 400;
}

function redirectResponse(res: Response, start: number) {
  const location = res.headers.get('location');
  return Response.json({
    ok: false,
    status: res.status,
    code: 'redirect',
    error: location ? `Redirects to ${location}, which the test doesn't follow.` : 'Redirects.',
    elapsedMs: elapsedSince(start),
  });
}

/** How long a probe waits for the whole response, body included. */
const TIMEOUT_MS = 10_000;

/** A probe whose address can't be called. */
const INVALID_URL = { code: 'invalid_url', error: "That isn't a web address the test can call." };

/** Why a probe got no answer, in the test's own words: the caught failure's text stays on the server. */
function unansweredReason(err: unknown): { code: string; error: string } {
  const kind = errorKind(err);
  if (kind === 'blocked') {
    return {
      code: 'ssrf_blocked',
      error: "The test doesn't call this address. It calls public web addresses only.",
    };
  }
  if (kind === 'request') return INVALID_URL;
  if (kind === 'timeout') {
    return {
      code: 'network_error',
      error: `No complete response within ${String(TIMEOUT_MS / 1000)} s.`,
    };
  }
  return {
    code: 'network_error',
    error: "The request didn't get a response. Check that the service is up.",
  };
}

/** A probe that never got an answer: refused by the network guard, or failed on the way. */
function fetchErrorResponse(start: number, err: unknown) {
  return Response.json({ ok: false, ...unansweredReason(err), elapsedMs: elapsedSince(start) });
}

/** How much of a response body a probe reads; enough for a large MCP tool list. */
const MAX_BODY_BYTES = 1_000_000;

/** Reads the body as text, stopping at `MAX_BODY_BYTES`. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return text + decoder.decode();
}

/**
 * Fetches `url` through the kernel's network guard and reads its body within `TIMEOUT_MS`.
 * Redirects are never followed: the credential and headers are for `url`'s origin alone. A
 * redirect comes back as the response.
 */
async function fetchWithTimeout(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  guard: ProbeGuard,
): Promise<{ res: Response; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    const res = await fetchGuarded(
      url,
      { ...init, signal: controller.signal },
      { followRedirects: false, ...guard },
    );
    return { res, text: await readCapped(res) };
  } catch (err) {
    if (controller.signal.aborted) {
      // labels-exempt: internal diagnostic; the visitor reads the test's own line for a timeout
      throw new TheoremError('timeout', 'probe: no complete response in time');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function previewResponseBody(text: string, contentType: string): string {
  if (!contentType.includes('application/json')) return text.slice(0, 300);
  try {
    return JSON.stringify(JSON.parse(text), null, 2).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/**
 * Why the endpoint and the sample input made no URL, naming the path parameter left unfilled. The
 * name is read from the endpoint the visitor sent; the caught failure's text stays on the server.
 */
function mappingReason(
  endpoint: string,
  pathParams: readonly string[],
  sampleInput: Record<string, unknown>,
): string {
  const named = [...endpoint.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)].map(([, name]) => name);
  const unlisted = named.find((name) => !pathParams.includes(name));
  if (unlisted) return `{${unlisted}} is in the endpoint, but isn't one of its path parameters.`;
  const unfilled = named.find((name) => sampleInput[name] === undefined);
  if (unfilled) return `The sample input has no value for the path parameter {${unfilled}}.`;
  return "The endpoint and the sample input don't make a URL. Start the endpoint with a fixed scheme and host, and keep . and .. out of its path parameters.";
}

async function handleHttpProbe(
  body: Extract<TestConnectionRequest, { type: 'http' }>,
  start: number,
  guard: ProbeGuard,
) {
  if (typeof body.endpoint !== 'string' || !body.endpoint.trim()) {
    return Response.json({ ok: false, error: 'Endpoint URL is required' }, { status: 400 });
  }

  const signed = probeCredential(body.auth, body.testCredential);
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    ...(body.headers ?? {}),
    ...signed.headers,
  };

  const method = (body.method?.toUpperCase() || 'GET') as HttpMethod;
  const sampleInput = body.sampleInput ?? {};
  let requestUrl = body.endpoint;
  let requestBody: string | undefined;

  try {
    const target = buildHttpToolTarget(body.endpoint, method, sampleInput, {
      pathParams: body.pathParams,
      queryParams: body.queryParams,
      bodyParam: body.bodyParam,
    });
    requestUrl = withCredentialQuery(new URL(target.url), signed.query).href;
    requestBody = target.body;
  } catch {
    return Response.json({
      ok: false,
      code: 'invalid_mapping',
      error: mappingReason(body.endpoint, body.pathParams ?? [], sampleInput),
      elapsedMs: elapsedSince(start),
    });
  }

  try {
    const { res, text } = await fetchWithTimeout(
      requestUrl,
      { method, headers, ...(method === 'GET' ? {} : { body: requestBody }) },
      guard,
    );
    if (isRedirect(res)) return redirectResponse(res, start);
    const contentType = res.headers.get('content-type') || '';
    return Response.json({
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      contentType,
      preview: previewResponseBody(text, contentType),
      elapsedMs: elapsedSince(start),
    });
  } catch (fetchErr) {
    return fetchErrorResponse(start, fetchErr);
  }
}

/** One MCP probe attempt: a response to send, or the protocol error that sends it to the next version. */
type McpAttempt =
  | { response: Response }
  | { status: number; protocolError: NonNullable<McpRpcResponse['error']> };

/** A `tools/list` call under one protocol version. */
function mcpToolsListRequest(
  baseHeaders: Record<string, string>,
  protocolVersion: string,
): Parameters<typeof fetchWithTimeout>[1] {
  const rpcPayload = {
    jsonrpc: '2.0',
    id: 'test-ping-1',
    method: 'tools/list',
    params: {
      _meta: mcpRequestMeta(protocolVersion),
    },
  };
  return {
    method: 'POST',
    headers: { ...baseHeaders, 'MCP-Protocol-Version': protocolVersion },
    body: JSON.stringify(rpcPayload),
  };
}

/** A body that isn't JSON-RPC: a plain-text version refusal tries the next version, else it fails. */
function nonJsonAttempt(
  res: Response,
  text: string,
  protocolVersion: string,
  start: number,
): McpAttempt {
  if (
    !res.ok &&
    text.toLowerCase().includes('unsupported protocol version') &&
    protocolVersion !== MCP_PROTOCOL_VERSIONS.at(-1)
  ) {
    return { status: res.status, protocolError: { code: -32600, message: text.slice(0, 300) } };
  }
  return {
    response: Response.json({
      ok: false,
      status: res.status,
      code: 'invalid_json',
      error: `MCP server returned non-JSON response: ${text.slice(0, 200)}`,
      elapsedMs: elapsedSince(start),
    }),
  };
}

/** What a JSON-RPC answer to `tools/list` says: an MCP error, not MCP at all, or the tool list. */
function mcpAnswerResponse(
  body: Extract<TestConnectionRequest, { type: 'mcp' }>,
  res: Response,
  rpcData: McpRpcResponse,
  protocolVersion: string,
  start: number,
): Response {
  if (rpcData.error) {
    return Response.json({
      ok: false,
      status: res.status,
      code: `mcp_error_${String(rpcData.error.code)}`,
      error: rpcData.error.message,
      elapsedMs: elapsedSince(start),
    });
  }
  if (rpcData.jsonrpc !== '2.0' || !Array.isArray(rpcData.result?.tools)) {
    return Response.json({
      ok: false,
      status: res.status,
      code: 'not_mcp',
      error: "Answered, but not as an MCP server: tools/list didn't return a tool list.",
      elapsedMs: elapsedSince(start),
    });
  }
  const tools = rpcData.result.tools;
  const toolNames = tools.map((t) => t.name);
  const targetName = body.mcpToolName?.trim();
  return Response.json({
    ok: res.ok,
    status: res.status,
    protocolVersion,
    toolCount: tools.length,
    tools: toolNames,
    targetToolFound: targetName ? toolNames.includes(targetName) : undefined,
    preview: JSON.stringify(rpcData.result ?? rpcData, null, 2).slice(0, 300),
    elapsedMs: elapsedSince(start),
  });
}

/** Asks the server for its tools under one protocol version. */
async function attemptMcpProbe(
  body: Extract<TestConnectionRequest, { type: 'mcp' }>,
  url: string,
  baseHeaders: Record<string, string>,
  protocolVersion: string,
  start: number,
  guard: ProbeGuard,
): Promise<McpAttempt> {
  const { res, text } = await fetchWithTimeout(
    url,
    mcpToolsListRequest(baseHeaders, protocolVersion),
    guard,
  );
  if (isRedirect(res)) return { response: redirectResponse(res, start) };
  let rpcData: McpRpcResponse;
  try {
    rpcData = parseMcpRpcResponse(text);
  } catch {
    return nonJsonAttempt(res, text, protocolVersion, start);
  }
  if (rpcData.error && isUnsupportedMcpProtocolError(rpcData.error)) {
    return { status: res.status, protocolError: rpcData.error };
  }
  return { response: mcpAnswerResponse(body, res, rpcData, protocolVersion, start) };
}

async function handleMcpProbe(
  body: Extract<TestConnectionRequest, { type: 'mcp' }>,
  start: number,
  guard: ProbeGuard,
) {
  if (typeof body.serverUrl !== 'string' || !body.serverUrl.trim()) {
    return Response.json({ ok: false, error: 'Server URL is required' }, { status: 400 });
  }

  const signed = probeCredential(body.auth, body.testCredential);
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(body.headers ?? {}),
    ...signed.headers,
  };

  const serverUrl = URL.parse(body.serverUrl);
  if (!serverUrl) {
    return Response.json({ ok: false, ...INVALID_URL, elapsedMs: elapsedSince(start) });
  }

  try {
    const url = withCredentialQuery(serverUrl, signed.query).href;
    let lastStatus = 0;
    let lastProtocolError: McpRpcResponse['error'];

    // Preferred version first; a server that refuses one is asked again under the next.
    for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
      const attempt = await attemptMcpProbe(body, url, baseHeaders, protocolVersion, start, guard);
      if ('response' in attempt) return attempt.response;
      lastStatus = attempt.status;
      lastProtocolError = attempt.protocolError;
    }

    return Response.json({
      ok: false,
      status: lastStatus || 400,
      code: lastProtocolError
        ? `mcp_error_${String(lastProtocolError.code)}`
        : 'mcp_protocol_error',
      error: lastProtocolError?.message ?? 'MCP protocol negotiation failed',
      elapsedMs: elapsedSince(start),
    });
  } catch (fetchErr) {
    return fetchErrorResponse(start, fetchErr);
  }
}

/**
 * `POST <base>/test-connection`: one request to a draft HTTP or MCP tool's endpoint. It reaches
 * public hosts only, unless `draftNetwork` is set: then it keeps to the network guardrail the
 * draft sends (`network`), as the draft's runs do. A name is checked against private addresses
 * only through `resolveHost`; without it, only the address as written is.
 */
export async function testConnection(
  request: Request,
  options: { resolveHost?: ResolveHost; draftNetwork?: boolean } = {},
): Promise<Response> {
  const start = Date.now();
  try {
    const rawBody = await readBody(request, z.unknown());
    if (!rawBody || typeof rawBody !== 'object' || !('type' in rawBody)) {
      return Response.json(
        { ok: false, error: 'Missing type in test connection request' },
        { status: 400 },
      );
    }
    const { type } = rawBody;
    if (type !== 'http' && type !== 'mcp') {
      return Response.json({ ok: false, error: 'Type must be http or mcp' }, { status: 400 });
    }
    const body = rawBody as TestConnectionRequest;
    const sent = draftNetworkSchema.safeParse((rawBody as { network?: unknown }).network);
    if (!sent.success) {
      throw new TheoremError(
        'request',
        'test connection: network is not a draft network guardrail',
      ); // labels-exempt: internal diagnostic
    }
    const network = sent.data;
    const guard: ProbeGuard = {
      ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
      ...(options.draftNetwork && network ? { policy: network } : {}),
    };
    if (body.type === 'http') return await handleHttpProbe(body, start, guard);
    return await handleMcpProbe(body, start, guard);
  } catch (err) {
    return Response.json({ ok: false, ...clientError(err) }, { status: caughtStatus(err) });
  }
}
