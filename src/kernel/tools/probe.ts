/**
 * One request to an HTTP or MCP tool's service, sent the way the tool's own calls send it, so a
 * host can tell whether the service answers, and whether it takes a credential, before a model
 * calls the tool.
 *
 * @module
 */
import { errorKind } from '../../guardrails/error.ts';
import { fetchGuarded, type ResolveHost } from '../../guardrails/network.ts';
import type { NetworkGuardrailSpec } from '../../guardrails/types.ts';
import { createMcpSessionCache } from './mcp-sessions.ts';
import {
  buildHttpToolTarget,
  type CredentialQuery,
  credentialPlacement,
  credentialRefusal,
  httpRequestHeaders,
  MCP_REQUEST_HEADERS,
  type McpNegotiated,
  type McpTransport,
  negotiateInSession,
  negotiateMcpRpc,
  omitSecretText,
  readCappedText,
  withCredentialQuery,
} from './remote.ts';
import type { HttpToolDef, ToolAuthConfig } from './types.ts';

/** The service a probe asks: an HTTP tool's request, or an MCP server's tool list. */
export type ToolProbeTarget =
  | {
      type: 'http';
      endpoint: string;
      /** Default `GET`. */
      method?: HttpToolDef['method'];
      /** The tool's input for this request: it fills the path, query and body as the tool's mapping says. */
      input?: Record<string, unknown>;
      mapping?: HttpToolDef['mapping'];
      headers?: Record<string, string>;
    }
  | {
      type: 'mcp';
      serverUrl: string;
      headers?: Record<string, string>;
    };

/** Options for {@link probeTool}. */
export interface ProbeToolOptions {
  target: ToolProbeTarget;
  /** Where the credential goes, as the tool declares it. An `api_key` goes as a key; any other type as a bearer token. */
  auth?: Pick<ToolAuthConfig, 'type' | 'headerName' | 'headerPrefix' | 'queryParam'>;
  /** The credential to try. Without it, the request goes without one. */
  credential?: string;
  /** The network guardrail the request keeps to, as a run's. Without it, public addresses only. */
  network?: NetworkGuardrailSpec;
  /** Checks each host name against private addresses, as a run's. */
  resolveHost?: ResolveHost;
  /** How long the whole answer may take, body included. Without it, no limit, as a tool's own call. */
  timeoutMs?: number;
  /** The most of the body that is read. Without it, no limit, as a tool's own call. */
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** What the service answered: its status and body, with the credential replaced wherever it echoed it. */
export interface ToolProbeAnswer {
  status: number;
  statusText: string;
  contentType: string;
  body: string;
}

/**
 * What a probe found.
 *
 * - `accepted`: a 2xx answer; for MCP, a tool list.
 * - `refused`: a 401 or 403 to a request that carried the credential, read as a tool's own call reads it.
 * - `inconclusive`: the service answered, but neither accepted nor refused the credential.
 * - `unanswered`: no answer came back.
 */
export type ToolProbe =
  | {
      verdict: 'accepted';
      answer: ToolProbeAnswer;
      /** For an MCP server: the protocol version it answered under, and its tools' names. */
      mcp?: { protocolVersion: string; tools: string[] };
    }
  | { verdict: 'refused'; answer: ToolProbeAnswer }
  | {
      verdict: 'inconclusive';
      /**
       * - `status`: an answer that is neither 2xx nor a refusal, such as 402, 404 or 500.
       * - `too_large`: the body ran past `maxResponseBytes`.
       * - `not_json`: an MCP server's answer that is not JSON-RPC.
       * - `not_mcp`: JSON-RPC, but no tool list.
       * - `mcp_error`: an MCP error, or no protocol version both sides speak.
       * - `mcp_session`: the server asked for a session and could not open one.
       */
      reason: 'status' | 'too_large' | 'not_json' | 'not_mcp' | 'mcp_error' | 'mcp_session';
      answer?: ToolProbeAnswer;
      /** The MCP error, for `mcp_error`. */
      error?: { code: number; message: string };
    }
  | {
      verdict: 'unanswered';
      /**
       * - `blocked`: the network guardrail refused the address.
       * - `invalid_url`: the address is not one a request can go to.
       * - `invalid_mapping`: the endpoint and input make no URL.
       * - `timeout`: no whole answer within `timeoutMs`.
       * - `network`: the request failed on the way.
       */
      reason: 'blocked' | 'invalid_url' | 'invalid_mapping' | 'timeout' | 'network';
    };

type Placed = { headers: Record<string, string>; query?: CredentialQuery; secret?: string };

function placeCredential(auth: ProbeToolOptions['auth'], credential: string | undefined): Placed {
  if (!credential) return { headers: {} };
  const config = auth ?? { type: 'bearer' as const };
  const sent =
    config.type === 'api_key'
      ? ({ type: 'api_key', key: credential } as const)
      : ({ type: 'bearer', token: credential } as const);
  return { ...credentialPlacement(config, sent), secret: credential };
}

function unanswered(err: unknown): ToolProbe {
  const kind = errorKind(err);
  if (kind === 'blocked') return { verdict: 'unanswered', reason: 'blocked' };
  if (kind === 'request') return { verdict: 'unanswered', reason: 'invalid_url' };
  if (kind === 'timeout') return { verdict: 'unanswered', reason: 'timeout' };
  return { verdict: 'unanswered', reason: 'network' };
}

/** The caller's signal and the probe's timeout, as one. */
function probeSignal(options: ProbeToolOptions): AbortSignal | undefined {
  const timedOut =
    options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
  if (timedOut && options.signal) return AbortSignal.any([options.signal, timedOut]);
  return timedOut ?? options.signal;
}

function hidden(text: string, secret: string | undefined): string {
  return secret ? omitSecretText(text, secret) : text;
}

async function probeHttp(
  target: Extract<ToolProbeTarget, { type: 'http' }>,
  placed: Placed,
  options: ProbeToolOptions,
): Promise<ToolProbe> {
  const method = target.method ?? 'GET';
  let url: string;
  let body: string | undefined;
  try {
    const built = buildHttpToolTarget(target.endpoint, method, target.input ?? {}, target.mapping);
    url = withCredentialQuery(new URL(built.url), placed.query).href;
    body = built.body;
  } catch {
    return { verdict: 'unanswered', reason: 'invalid_mapping' };
  }
  const response = await fetchGuarded(
    url,
    {
      method,
      headers: httpRequestHeaders(method),
      ...(method === 'GET' ? {} : { body }),
      signal: probeSignal(options),
    },
    {
      policy: options.network,
      followRedirects: true,
      originBoundHeaders: { ...target.headers, ...placed.headers },
      resolveHost: options.resolveHost,
      fetchFn: options.fetch,
    },
  );
  const text = await readCappedText(response, options.maxResponseBytes);
  if (text === undefined) return { verdict: 'inconclusive', reason: 'too_large' };
  const answer: ToolProbeAnswer = {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type') ?? '',
    body: hidden(text, placed.secret),
  };
  if (response.ok) return { verdict: 'accepted', answer };
  if (placed.secret !== undefined && credentialRefusal(response)) {
    return { verdict: 'refused', answer };
  }
  return { verdict: 'inconclusive', reason: 'status', answer };
}

function mcpAnswer(status: number, body: string): ToolProbeAnswer {
  return { status, statusText: '', contentType: '', body };
}

/** An MCP server's answer, read as a probe: a tool list, a refusal, or why it is neither. */
function readMcp(negotiated: McpNegotiated, placed: Placed): ToolProbe {
  const answer = negotiated.answer
    ? mcpAnswer(negotiated.answer.status, hidden(negotiated.answer.body, placed.secret))
    : undefined;
  const withAnswer = answer ? { answer } : {};
  if (negotiated.refusal && placed.secret !== undefined && answer) {
    return { verdict: 'refused', answer };
  }
  const { failure, rpc } = negotiated;
  if (failure?.code === 'response_too_large')
    return { verdict: 'inconclusive', reason: 'too_large' };
  if (failure?.code === 'invalid_response') {
    return { verdict: 'inconclusive', reason: 'not_json', ...withAnswer };
  }
  if (failure?.code.startsWith('mcp_session')) {
    return { verdict: 'inconclusive', reason: 'mcp_session' };
  }
  if (failure) return { verdict: 'inconclusive', reason: 'status', ...withAnswer };
  if (!rpc) {
    const error = negotiated.lastProtocolError;
    return {
      verdict: 'inconclusive',
      reason: 'mcp_error',
      ...(error
        ? { error: { code: error.code, message: hidden(error.message, placed.secret) } }
        : {}),
    };
  }
  if (rpc.error) {
    return {
      verdict: 'inconclusive',
      reason: 'mcp_error',
      error: { code: rpc.error.code, message: hidden(rpc.error.message, placed.secret) },
    };
  }
  const listed = rpc.result?.tools;
  const body = hidden(JSON.stringify(rpc.result ?? rpc), placed.secret);
  if (rpc.jsonrpc !== '2.0' || !Array.isArray(listed)) {
    return { verdict: 'inconclusive', reason: 'not_mcp', answer: mcpAnswer(200, body) };
  }
  return {
    verdict: 'accepted',
    answer: { status: 200, statusText: 'OK', contentType: 'application/json', body },
    mcp: {
      protocolVersion: negotiated.protocolVersion ?? '',
      tools: listed.map((tool: { name: string }) => tool.name),
    },
  };
}

async function probeMcp(
  target: Extract<ToolProbeTarget, { type: 'mcp' }>,
  placed: Placed,
  options: ProbeToolOptions,
): Promise<ToolProbe> {
  const serverUrl = URL.parse(target.serverUrl);
  if (!serverUrl) return { verdict: 'unanswered', reason: 'invalid_url' };
  const transport: McpTransport = {
    url: withCredentialQuery(serverUrl, placed.query).href,
    headers: { ...MCP_REQUEST_HEADERS },
    originBoundHeaders: { ...target.headers, ...placed.headers },
    policy: options.network,
    resolveHost: options.resolveHost,
    fetch: options.fetch,
    signal: probeSignal(options),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
  };
  const call = { id: 'probe', method: 'tools/list', params: {} } as const;
  const first = await negotiateMcpRpc(transport, call);
  const negotiated = first.sessionRequired
    ? await negotiateInSession(transport, call, {
        cache: createMcpSessionCache(),
        key: transport.url,
        use: { tool: 'probe' },
      })
    : first;
  return readMcp(negotiated, placed);
}

/**
 * Sends one request to an HTTP or MCP tool's service, the way the tool's own calls send it: the
 * credential where `auth` puts it, through the network guardrail, redirects followed with the
 * credential kept to the first origin. An MCP server is asked for its tool list, in a session when
 * it asks for one. Nothing is stored, and the result never holds the credential.
 *
 * @example
 * ```ts
 * const probe = await probeTool({
 *   target: { type: 'http', endpoint: 'https://api.station.example/v1/devices' },
 *   auth: { type: 'api_key', headerName: 'X-Station-Key' },
 *   credential: pasted,
 *   timeoutMs: 10_000,
 * });
 * if (probe.verdict === 'accepted') await keep(pasted);
 * ```
 */
export async function probeTool(options: ProbeToolOptions): Promise<ToolProbe> {
  const placed = placeCredential(options.auth, options.credential);
  try {
    return options.target.type === 'http'
      ? await probeHttp(options.target, placed, options)
      : await probeMcp(options.target, placed, options);
  } catch (err) {
    if (options.signal?.aborted) throw err;
    return unanswered(err);
  }
}
