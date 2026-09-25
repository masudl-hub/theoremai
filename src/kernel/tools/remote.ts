/**
 * Execution runners for Declarative HTTP and Remote MCP tools.
 *
 * Implements:
 * - URL parameter substitution and query/body mapping
 * - Network SSRF guardrail enforcement on the target and every redirect hop
 * - Endpoint templates whose scheme and host are fixed, so input never picks the host
 * - Credential resolution (bearer, api_key, oauth2), sent only to the configured origin
 * - Proactive OAuth token refresh, one per grant at a time; the progress event names
 *   the slot, never the secret, and a refused refresh's server text stays internal
 * - A response that repeats its credential is stripped of it
 * - ToolGate { kind: 'auth' } emission or model error reporting
 * - Streamable HTTP MCP JSON-RPC protocol (`tools/call`) per 2026-07-28 spec
 *
 * @module
 */

import { errorKind } from '../../guardrails/error.ts';
import { lexiconText } from '../../guardrails/lexicon.ts';
import { fetchGuarded, type ResolveHost } from '../../guardrails/network.ts';
import type { ErrorKind } from '../../guardrails/theorem-error.ts';
import type { NetworkGuardrailSpec } from '../../guardrails/types.ts';
import { refreshOAuthToken, tokenAudienceCovers } from '../auth/oauth.ts';
import type { OAuth2Credential, OAuthTransportOptions, ToolCredential } from '../auth/types.ts';
import { mapStrings } from '../engine/tree.ts';
import type { TurnEvent } from '../types.ts';
import {
  guardToolTarget,
  messageOf,
  networkBlocked,
  startToolExecution,
  type ToolCallBase,
  toolEvent,
  toolNetworkPolicy,
} from './events.ts';
import { checkPermission } from './permission.ts';
import { assertFixedEndpointOrigin } from './schema.ts';
import { runPreToolPipeline, type ToolStageSupport } from './stage-run.ts';
import type {
  HttpToolAuthConfig,
  HttpToolDef,
  McpToolDef,
  ModelToolResult,
  ToolBodyOutcome,
  ToolContext,
  ToolFailure,
  ToolGate,
} from './types.ts';

export type AuthResolveResult = {
  headers: Record<string, string>;
  /** The credential value sent; the response is stripped of it before anyone reads it. */
  secret?: string;
  /** The resource (RFC 8707) an OAuth token was issued for; it goes nowhere else. */
  audience?: string;
  unauthenticated?: boolean;
  modelMessage?: string;
  gate?: ToolGate;
};

function authHeaderPair(
  authConfig: HttpToolAuthConfig,
  value: string,
  defaults: { headerName: string; headerPrefix: string },
): Record<string, string> {
  const headerName = authConfig.headerName ?? defaults.headerName;
  const headerPrefix = authConfig.headerPrefix ?? defaults.headerPrefix;
  return { [headerName]: `${headerPrefix}${value}` };
}

function buildAuthGate(
  toolName: string,
  authConfig: HttpToolAuthConfig,
  message: string,
  extras?: { issuer?: string; resource?: string },
): ToolGate {
  return {
    kind: 'auth',
    tool: toolName,
    authChallenge: {
      slot: authConfig.slot,
      authType: authConfig.type,
      message,
      issuer: extras?.issuer ?? authConfig.preResolved?.issuer,
      resource: extras?.resource ?? authConfig.preResolved?.resource,
      requiredScopes: authConfig.scopes,
    },
  };
}

function unauthenticatedResult(
  toolName: string,
  authConfig: HttpToolAuthConfig,
  message: string,
  policy: string,
  extras?: { issuer?: string; resource?: string },
): AuthResolveResult & { gate?: ToolGate } {
  if (policy === 'pause') {
    // Policy name remains `pause` in schema; wire is honest `gate`.
    // Do not emit gate here — caller uses emitGateSettlement (pre_tool + gate).
    const gate = buildAuthGate(toolName, authConfig, message, extras);
    return { headers: {}, unauthenticated: true, gate };
  }
  return { headers: {}, unauthenticated: true, modelMessage: message };
}

function resolveStaticCredential(
  credential: ToolCredential,
  authConfig: HttpToolAuthConfig,
): AuthResolveResult | undefined {
  if (credential.type === 'bearer') {
    return {
      headers: authHeaderPair(authConfig, credential.token, {
        headerName: 'Authorization',
        headerPrefix: 'Bearer ',
      }),
      secret: credential.token,
    };
  }
  if (credential.type === 'api_key') {
    const headerName = credential.headerName ?? authConfig.headerName ?? 'Authorization';
    const headerPrefix = credential.headerPrefix ?? authConfig.headerPrefix ?? '';
    return {
      headers: { [headerName]: `${headerPrefix}${credential.key}` },
      secret: credential.key,
    };
  }
  return undefined;
}

/**
 * Refreshes in flight, by grant. Calls that find the same expired token share
 * one refresh: with rotating refresh tokens a second request would present a
 * spent token, which a server may treat as theft and revoke the whole grant.
 */
const refreshesInFlight = new Map<string, Promise<OAuth2Credential>>();

function refreshOnce(
  credential: OAuth2Credential,
  refreshToken: string,
  transport: OAuthTransportOptions,
): Promise<OAuth2Credential> {
  const grant = `${credential.tokenEndpoint}\n${refreshToken}`;
  const inFlight = refreshesInFlight.get(grant);
  if (inFlight) return inFlight;
  const refresh = refreshOAuthToken({
    refreshToken,
    tokenEndpoint: credential.tokenEndpoint,
    clientId: credential.clientId,
    resource: credential.resource,
    scope: credential.scope,
    issuer: credential.issuer,
    ...transport,
  }).then((result) => result.credential);
  refreshesInFlight.set(grant, refresh);
  const settle = () => refreshesInFlight.delete(grant);
  refresh.then(settle, settle);
  return refresh;
}

async function* resolveOAuth2Credential(
  toolName: string,
  authConfig: HttpToolAuthConfig,
  credential: OAuth2Credential,
  ctx: ToolContext,
  base: ToolCallBase,
  policy: string,
): AsyncGenerator<TurnEvent, AuthResolveResult> {
  const slot = authConfig.slot;
  const bound = { issuer: credential.issuer, resource: credential.resource };
  // A token goes only to the resource it was issued for; one that names none
  // has nowhere it may go, so the user signs in again.
  if (typeof credential.resource !== 'string' || credential.resource.length === 0) {
    const message = `OAuth credential for '${toolName}' (slot: '${slot}') does not name the resource it was issued for.`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return unauthenticatedResult(toolName, authConfig, message, policy, bound);
  }
  let active = credential;
  const isExpired =
    credential.expiresAt !== undefined && credential.expiresAt <= Date.now() + 30000;

  if (isExpired && credential.refreshToken) {
    try {
      active = await refreshOnce(credential, credential.refreshToken, {
        network: toolNetworkPolicy(ctx),
        resolveHost: ctx.resolveHost,
      });
    } catch (err) {
      // The server's own words are untrusted text: they go to the host as
      // `errorInternal`, never to the model or the client.
      yield {
        ...toolEvent(base, {
          phase: 'progress',
          data: { kind: 'auth_token_refresh_failed', slot },
        }),
        errorInternal: messageOf(err),
      };
      const message = `Failed to refresh OAuth token for '${toolName}' (slot: '${slot}').`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return unauthenticatedResult(toolName, authConfig, message, policy, bound);
    }
    // The refreshed credential replaces the slot in the host's `credentials`
    // record; the event only names the slot, so no token rides the stream.
    if (ctx.credentials) {
      ctx.credentials[slot] = active;
    }
    yield toolEvent(base, {
      phase: 'progress',
      data: { kind: 'auth_token_refreshed', slot },
    });
  } else if (isExpired) {
    const message = `OAuth token expired for '${toolName}' (slot: '${slot}') and no refresh token is available.`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return unauthenticatedResult(toolName, authConfig, message, policy, bound);
  }

  return {
    headers: authHeaderPair(authConfig, active.accessToken, {
      headerName: 'Authorization',
      headerPrefix: 'Bearer ',
    }),
    secret: active.accessToken,
    audience: credential.resource,
  };
}

/**
 * Resolves credentials and handles missing/expired tokens.
 * Yields TurnEvents for auth pauses or progress (e.g. refreshed tokens).
 */
export async function* resolveToolAuth(
  toolName: string,
  authConfig: HttpToolAuthConfig | undefined,
  ctx: ToolContext,
  base: ToolCallBase,
): AsyncGenerator<TurnEvent, AuthResolveResult> {
  if (!authConfig) {
    return { headers: {} };
  }

  const credential = ctx.credentials?.[authConfig.slot];
  const policy = authConfig.onUnauthenticated ?? 'pause';

  if (!credential) {
    const message = `Authentication required for '${toolName}' (auth slot: '${authConfig.slot}').`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return unauthenticatedResult(toolName, authConfig, message, policy);
  }

  const staticResolved = resolveStaticCredential(credential, authConfig);
  if (staticResolved) {
    return staticResolved;
  }

  if (credential.type === 'oauth2') {
    return yield* resolveOAuth2Credential(toolName, authConfig, credential, ctx, base, policy);
  }

  return { headers: {} };
}

export type HttpToolMapping = NonNullable<HttpToolDef['mapping']>;

/**
 * One path parameter, encoded. `encodeURIComponent` leaves `.` and `..` as they
 * are and a URL resolves them, walking the endpoint's path; they are refused.
 */
function pathSegment(param: string, value: string): string {
  if (value === '.' || value === '..') {
    throw new Error(`Path parameter "${param}" cannot be "${value}"`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return encodeURIComponent(value);
}

export type HttpToolTarget = {
  url: string;
  body?: string;
};

/**
 * Build the request URL (and optional JSON body) for a declarative HTTP tool
 * from endpoint template, mapping, and validated input.
 */
export function buildHttpToolTarget(
  endpoint: string,
  method: HttpToolDef['method'],
  input: Record<string, unknown>,
  mapping?: HttpToolMapping,
): HttpToolTarget {
  assertFixedEndpointOrigin(endpoint);
  let urlStr = endpoint;
  const pathParams = mapping?.pathParams ?? [];
  for (const param of pathParams) {
    const val = input[param];
    if (val !== undefined) {
      urlStr = urlStr.replaceAll(`{${param}}`, pathSegment(param, String(val)));
    }
  }

  const unreplacedMatch = urlStr.match(/\{([a-zA-Z0-9_-]+)\}/);
  if (unreplacedMatch) {
    throw new Error(
      `Missing required path parameter "${unreplacedMatch[1]}" for endpoint "${endpoint}"`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }

  const targetUrl = new URL(urlStr);
  const queryParams = mapping?.queryParams ?? [];
  for (const param of queryParams) {
    const val = input[param];
    if (val !== undefined) {
      targetUrl.searchParams.set(param, String(val));
    }
  }

  if (method === 'GET') {
    return { url: targetUrl.toString() };
  }

  if (mapping?.bodyParam) {
    return { url: targetUrl.toString(), body: JSON.stringify(input[mapping.bodyParam]) };
  }

  const bodyObj: Record<string, unknown> = {};
  const excluded = new Set([...pathParams, ...queryParams]);
  for (const [k, v] of Object.entries(input)) {
    if (!excluded.has(k)) {
      bodyObj[k] = v;
    }
  }
  return { url: targetUrl.toString(), body: JSON.stringify(bodyObj) };
}

function parseHttpResponseData(contentType: string, text: string, status: number): unknown {
  if (contentType.includes('application/json') && text.trim().length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (text.trim().length === 0 && status === 204) {
    return null;
  }
  return text;
}

export function parseToolOutput<T>(
  schema: {
    safeParse: (
      data: unknown,
    ) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } };
  },
  responseData: unknown,
): { success: true; data: T } | { success: false; error: { flatten: () => unknown } } {
  let checked = schema.safeParse(responseData);
  if (!checked.success && typeof responseData === 'string' && responseData.trim().length > 0) {
    try {
      const jsonParsed = JSON.parse(responseData);
      const retryChecked = schema.safeParse(jsonParsed);
      if (retryChecked.success) {
        checked = retryChecked;
      }
    } catch {
      // Not JSON
    }
  }
  return checked;
}

/**
 * A result with no summary of its own: the output itself is the finding. It is
 * not repeated as `data`, which `composeToolText` would append a second time.
 */
export function modelResultFromOutput(data: unknown): ModelToolResult {
  return { finding: typeof data === 'string' ? data : JSON.stringify(data) };
}

function failureOutcome(
  failure: ToolFailure,
  callNotStarted: boolean,
): Extract<ToolBodyOutcome, { kind: 'failed' }> {
  return { kind: 'failed', failure, callNotStarted };
}

/** Tool `preTool` + host `pre_tool` + mutate re-parse, mapped onto a remote outcome. */
async function* runRemotePreBodyStages(args: {
  tool: HttpToolDef | McpToolDef;
  input: unknown;
  ctx: ToolContext;
  base: ToolCallBase;
  stages?: ToolStageSupport;
}): AsyncGenerator<TurnEvent, { ok: true; input: unknown } | ToolBodyOutcome> {
  const pre = yield* runPreToolPipeline(args);
  if (pre.ok) return pre;
  if (pre.kind === 'aborted') {
    return { kind: 'aborted', aborted: pre.aborted };
  }
  if (pre.kind === 'gated') {
    return { kind: 'gated', gate: pre.gate };
  }
  return { ...failureOutcome(pre.failure, true), ...(pre.denied ? { denied: true } : {}) };
}

async function* remoteParseAndPermit(
  tool: HttpToolDef | McpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
): AsyncGenerator<
  TurnEvent,
  { ok: true; input: unknown } | { ok: false; outcome: ToolBodyOutcome }
> {
  const started = yield* startToolExecution(tool, rawInput, ctx, base);
  if (!started.ok) {
    return {
      ok: false,
      outcome: failureOutcome(
        {
          code: 'invalid_input',
          kind: 'bad_response',
          message: lexiconText('tool.input_invalid', {}, ctx.profile.lexicon),
        },
        true,
      ),
    };
  }
  const permissionGate = checkPermission(
    tool.name,
    tool.permission,
    ctx.sessionPermissions,
    ctx.resume,
  );
  if (permissionGate) {
    return { ok: false, outcome: { kind: 'gated', gate: permissionGate } };
  }
  return { ok: true, input: started.data };
}

function outcomeFromUnauth(authRes: {
  unauthenticated?: boolean;
  gate?: import('./types.ts').ToolGate;
  modelMessage?: string;
}): ToolBodyOutcome | undefined {
  if (!authRes.unauthenticated) return undefined;
  if (authRes.gate) return { kind: 'gated', gate: authRes.gate };
  if (authRes.modelMessage) {
    return {
      kind: 'ok',
      modelResult: { finding: authRes.modelMessage },
      outputRaw: { unauthenticated: true, message: authRes.modelMessage },
    };
  }
  return failureOutcome(
    { code: 'not_authorized', kind: 'auth', message: 'Tool authentication required' }, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    true,
  );
}

async function* remoteAuthAndPreBody(args: {
  tool: HttpToolDef | McpToolDef;
  input: unknown;
  ctx: ToolContext;
  base: ToolCallBase;
  stages?: ToolStageSupport;
}): AsyncGenerator<
  TurnEvent,
  | {
      ok: true;
      input: unknown;
      authHeaders: Record<string, string>;
      secret?: string;
      audience?: string;
    }
  | ToolBodyOutcome
> {
  const authRes = yield* resolveToolAuth(args.tool.name, args.tool.auth, args.ctx, args.base);
  const unauth = outcomeFromUnauth(authRes);
  if (unauth) return unauth;

  const preBody = yield* runRemotePreBodyStages({
    tool: args.tool,
    input: args.input,
    ctx: args.ctx,
    base: args.base,
    stages: args.stages,
  });
  if (!('ok' in preBody)) return preBody;
  return {
    ok: true,
    input: preBody.input,
    authHeaders: authRes.headers ?? {},
    ...(authRes.secret ? { secret: authRes.secret } : {}),
    ...(authRes.audience ? { audience: authRes.audience } : {}),
  };
}

/** A request that threw: a redirect hop the network policy refused, or no response at all. */
function* thrownOutcome(err: unknown): Generator<TurnEvent, ToolBodyOutcome> {
  if (errorKind(err) === 'blocked') {
    return failureOutcome(yield* networkBlocked(err), false);
  }
  return failureOutcome({ code: 'network_error', kind: 'network', message: messageOf(err) }, false);
}

/** What stands in for a credential a response repeated. */
const OMIT_CREDENTIAL = '[omitted - credential]';

/**
 * A response that repeats the credential it was sent with (an echo endpoint, a
 * debug error page) is stripped of it, so the value never reaches the model,
 * the trace, or the client.
 */
function withoutSecret(outcome: ToolBodyOutcome, secret: string | undefined): ToolBodyOutcome {
  if (!secret) return outcome;
  const strip = (text: string) => text.replaceAll(secret, OMIT_CREDENTIAL);
  if (outcome.kind === 'ok') {
    const outputRaw = mapStrings(outcome.outputRaw, strip);
    return { kind: 'ok', outputRaw, modelResult: modelResultFromOutput(outputRaw) };
  }
  if (outcome.kind === 'failed') {
    const { failure } = outcome;
    return {
      ...outcome,
      failure: {
        ...failure,
        message: strip(failure.message),
        ...(failure.details === undefined ? {} : { details: mapStrings(failure.details, strip) }),
      },
    };
  }
  return outcome;
}

/**
 * Send with the call's credential. An OAuth token goes only to the resource it
 * was issued for (RFC 8707), so any other target gets no request; the response
 * is stripped of the credential if it repeats it.
 */
async function* sendWithCredential(
  prepared: { audience?: string; secret?: string },
  url: URL,
  send: () => AsyncGenerator<TurnEvent, ToolBodyOutcome>,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  if (prepared.audience && !tokenAudienceCovers(prepared.audience, url)) {
    return failureOutcome(
      {
        code: 'credential_audience_mismatch',
        kind: 'config',
        message: `The OAuth token for "${prepared.audience}" cannot be sent to "${url.origin}${url.pathname}"`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      },
      true,
    );
  }
  return withoutSecret(yield* send(), prepared.secret);
}

/**
 * Executes a Declarative HTTP tool.
 * Order: schema → permission → auth → preTool/host stages → body.
 */
export async function* executeHttpTool(
  tool: HttpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
  stages?: ToolStageSupport,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const parsed = yield* remoteParseAndPermit(tool, rawInput, ctx, base);
  if (!parsed.ok) return parsed.outcome;
  let input: unknown = parsed.input as Record<string, unknown>;

  const prepared = yield* remoteAuthAndPreBody({ tool, input, ctx, base, stages });
  if (!('ok' in prepared)) return prepared;
  input = prepared.input as Record<string, unknown>;

  let target: HttpToolTarget;
  try {
    target = buildHttpToolTarget(
      tool.endpoint,
      tool.method,
      input as Record<string, unknown>,
      tool.mapping,
    );
  } catch (err) {
    const failure: ToolFailure = {
      code: 'invalid_input',
      kind: 'bad_response',
      message: messageOf(err),
    };
    return failureOutcome(failure, true);
  }

  const guarded = yield* guardToolTarget(target.url, ctx);
  if (!guarded.ok) return failureOutcome(guarded.failure, true);
  return yield* sendWithCredential(prepared, guarded.url, () =>
    sendHttpRequest(tool, guarded.url, target.body, prepared.authHeaders, ctx),
  );
}

async function* sendHttpRequest(
  tool: HttpToolDef,
  targetUrl: URL,
  body: string | undefined,
  authHeaders: Record<string, string>,
  ctx: ToolContext,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (tool.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetchGuarded(
      targetUrl.href,
      { method: tool.method, headers, body, signal: ctx.signal },
      {
        policy: toolNetworkPolicy(ctx),
        followRedirects: true,
        originBoundHeaders: { ...tool.headers, ...authHeaders },
        resolveHost: ctx.resolveHost,
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      const failure: ToolFailure = {
        code: `http_${response.status}`,
        kind: kindOfToolHttpStatus(response.status),
        message: `HTTP ${response.status} from ${targetUrl.hostname}: ${errText}`,
      };
      return failureOutcome(failure, false);
    }

    const text = await response.text();
    const responseData = parseHttpResponseData(
      response.headers.get('content-type') ?? '',
      text,
      response.status,
    );
    const checked = parseToolOutput(tool.output, responseData);
    if (!checked.success) {
      const failure: ToolFailure = {
        code: 'invalid_output',
        kind: 'bad_response',
        message: 'HTTP response did not match tool output schema', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        details: checked.error.flatten(),
      };
      return failureOutcome(failure, false);
    }

    return {
      kind: 'ok',
      modelResult: modelResultFromOutput(checked.data),
      outputRaw: checked.data,
    };
  } catch (err) {
    return yield* thrownOutcome(err);
  }
}

/** Preferred-first Streamable HTTP protocol revisions the kernel will negotiate. */
export const MCP_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
] as const;

/** Streamable HTTP MCP protocol revision supported by the kernel. */
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

/** Minimal JSON-RPC response shape consumed from an MCP server. */
export type McpRpcResponse = {
  jsonrpc?: string;
  id?: unknown;
  result?: {
    content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
  method?: string;
};

/** Parse MCP JSON or SSE (`event: message` / `data:`) bodies into a JSON-RPC object. */
export function parseMcpRpcResponse(text: string): McpRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as McpRpcResponse;
  }

  const messages: McpRpcResponse[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      messages.push(JSON.parse(payload) as McpRpcResponse);
    } catch {
      // Ignore non-JSON SSE payloads (e.g. pings).
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.result !== undefined && msg.method === undefined) return msg;
  }

  const last = messages.at(-1);
  if (!last) {
    throw new Error(`MCP server returned non-JSON response: ${text}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return last;
}

/** True when a JSON-RPC error indicates the server rejected our protocol revision. */
export function isUnsupportedMcpProtocolError(error: McpRpcResponse['error']): boolean {
  if (!error) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('unsupported protocol version') || // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    message.includes('inconsistent mcp protocol version') // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

function unsupportedProtocolFromHttpBody(text: string): McpRpcResponse['error'] | undefined {
  try {
    const rpcResponse = parseMcpRpcResponse(text);
    if (rpcResponse.error && isUnsupportedMcpProtocolError(rpcResponse.error)) {
      return rpcResponse.error;
    }
  } catch {
    // Fall through to raw-text heuristic for non-JSON error pages.
  }
  // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  if (text.toLowerCase().includes('unsupported protocol version')) {
    return { code: -32600, message: text };
  }
  return undefined;
}

type McpFetchOutcome =
  | { kind: 'rpc'; response: McpRpcResponse }
  | { kind: 'retry' }
  | { kind: 'protocol_retry'; error: McpRpcResponse['error'] }
  | { kind: 'failure'; failure: ToolFailure };

/** Where one MCP call goes and what rides with it. */
type McpTransport = {
  url: string;
  /** Protocol headers, sent on every hop. */
  headers: Record<string, string>;
  /** Host-configured headers and credentials: the configured origin only. */
  originBoundHeaders: Record<string, string>;
  policy?: NetworkGuardrailSpec;
  resolveHost?: ResolveHost;
  signal?: AbortSignal;
};

async function fetchMcpProtocolAttempt(
  transport: McpTransport,
  rpcId: string | number,
  mcpToolName: string,
  input: unknown,
  protocolVersion: string,
): Promise<McpFetchOutcome> {
  const jsonRpcPayload = {
    jsonrpc: '2.0',
    id: rpcId,
    method: 'tools/call',
    params: {
      name: mcpToolName,
      arguments: input,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': protocolVersion,
      },
    },
  };

  const response = await fetchGuarded(
    transport.url,
    {
      method: 'POST',
      headers: { ...transport.headers, 'MCP-Protocol-Version': protocolVersion },
      body: JSON.stringify(jsonRpcPayload),
      signal: transport.signal,
    },
    {
      policy: transport.policy,
      followRedirects: true,
      originBoundHeaders: transport.originBoundHeaders,
      resolveHost: transport.resolveHost,
    },
  );

  const text = await response.text();

  if (!response.ok) {
    const acceptRejected =
      response.status === 406 &&
      text.toLowerCase().includes('accept') &&
      protocolVersion !== MCP_PROTOCOL_VERSIONS.at(-1);
    if (acceptRejected) return { kind: 'retry' };
    const protocolError = unsupportedProtocolFromHttpBody(text);
    if (protocolError) return { kind: 'protocol_retry', error: protocolError };
    return {
      kind: 'failure',
      failure: {
        code: `mcp_http_${response.status}`,
        kind: kindOfToolHttpStatus(response.status),
        message: `MCP server error HTTP ${response.status}: ${text}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      },
    };
  }

  try {
    const rpcResponse = parseMcpRpcResponse(text);
    if (rpcResponse.error && isUnsupportedMcpProtocolError(rpcResponse.error)) {
      return { kind: 'protocol_retry', error: rpcResponse.error };
    }
    return { kind: 'rpc', response: rpcResponse };
  } catch {
    return {
      kind: 'failure',
      failure: {
        code: 'invalid_response',
        kind: 'bad_response',
        message: `MCP server returned non-JSON response: ${text}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      },
    };
  }
}

async function negotiateMcpRpc(
  transport: McpTransport,
  rpcId: string | number,
  mcpToolName: string,
  input: unknown,
): Promise<{
  rpc?: McpRpcResponse;
  failure?: ToolFailure;
  lastProtocolError?: McpRpcResponse['error'];
}> {
  let lastProtocolError: McpRpcResponse['error'];
  for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
    const outcome = await fetchMcpProtocolAttempt(
      transport,
      rpcId,
      mcpToolName,
      input,
      protocolVersion,
    );
    if (outcome.kind === 'retry' || outcome.kind === 'protocol_retry') {
      if (outcome.kind === 'protocol_retry') lastProtocolError = outcome.error;
      continue;
    }
    if (outcome.kind === 'failure') {
      return { failure: outcome.failure };
    }
    return { rpc: outcome.response };
  }
  return { lastProtocolError };
}

/** A tool server's non-OK HTTP status: refused credentials are `auth`; anything else, the step failed. */
function kindOfToolHttpStatus(status: number): ErrorKind {
  return status === 401 || status === 403 ? 'auth' : 'failed';
}

function extractMcpOutput(result: McpRpcResponse['result']): unknown {
  if (result?.content && Array.isArray(result.content)) {
    return result.content.map((c) => c.text ?? '').join('\n');
  }
  return result;
}

function mcpResultFailure(rpcResponse: McpRpcResponse): ToolFailure | undefined {
  if (rpcResponse.error) {
    return {
      code: `mcp_rpc_error_${rpcResponse.error.code}`,
      kind: 'failed',
      message: rpcResponse.error.message,
      details: rpcResponse.error.data,
    };
  }
  const result = rpcResponse.result;
  if (result?.isError) {
    return {
      code: 'mcp_tool_execution_failed',
      kind: 'failed',
      message: result.content?.map((c) => c.text ?? '').join('\n') ?? 'MCP Tool execution error', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    };
  }
  return undefined;
}

function interpretMcpRpc(
  tool: McpToolDef,
  negotiated: {
    rpc?: McpRpcResponse;
    failure?: ToolFailure;
    lastProtocolError?: McpRpcResponse['error'];
  },
): { ok: true; data: unknown } | { ok: false; failure: ToolFailure } {
  if (negotiated.failure) {
    return { ok: false, failure: negotiated.failure };
  }
  const rpcResponse = negotiated.rpc;
  if (!rpcResponse) {
    return {
      ok: false,
      failure: {
        code: 'mcp_protocol_error',
        kind: 'failed',
        message: negotiated.lastProtocolError?.message ?? 'MCP protocol negotiation failed', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        details: negotiated.lastProtocolError?.data,
      },
    };
  }
  const resultFailure = mcpResultFailure(rpcResponse);
  if (resultFailure) {
    return { ok: false, failure: resultFailure };
  }
  const checked = parseToolOutput(tool.output, extractMcpOutput(rpcResponse.result));
  if (!checked.success) {
    return {
      ok: false,
      failure: {
        code: 'invalid_output',
        kind: 'bad_response',
        message: 'MCP output schema validation failed', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        details: checked.error.flatten(),
      },
    };
  }
  return { ok: true, data: checked.data };
}

/**
 * Executes a Remote MCP tool over Streamable HTTP (spec revision 2026-07-28).
 * Order: schema → permission → auth → preTool/host stages → body.
 */
export async function* executeMcpTool(
  tool: McpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
  stages?: ToolStageSupport,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  const permitted = yield* remoteParseAndPermit(tool, rawInput, ctx, base);
  if (!permitted.ok) return permitted.outcome;

  const guarded = yield* guardToolTarget(tool.serverUrl, ctx);
  if (!guarded.ok) return failureOutcome(guarded.failure, true);

  const prepared = yield* remoteAuthAndPreBody({ tool, input: permitted.input, ctx, base, stages });
  if (!('ok' in prepared)) return prepared;
  return yield* sendWithCredential(prepared, guarded.url, () =>
    sendMcpRequest(tool, guarded.url, prepared.input, prepared.authHeaders, ctx, base),
  );
}

async function* sendMcpRequest(
  tool: McpToolDef,
  url: URL,
  input: unknown,
  authHeaders: Record<string, string>,
  ctx: ToolContext,
  base: ToolCallBase,
): AsyncGenerator<TurnEvent, ToolBodyOutcome> {
  try {
    const interpreted = interpretMcpRpc(
      tool,
      await negotiateMcpRpc(
        {
          url: url.href,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          originBoundHeaders: { ...tool.headers, ...authHeaders },
          policy: toolNetworkPolicy(ctx),
          resolveHost: ctx.resolveHost,
          signal: ctx.signal,
        },
        base.callId ?? Date.now(),
        tool.mcpToolName,
        input,
      ),
    );
    if (!interpreted.ok) {
      return failureOutcome(interpreted.failure, false);
    }
    return {
      kind: 'ok',
      modelResult: modelResultFromOutput(interpreted.data),
      outputRaw: interpreted.data,
    };
  } catch (err) {
    return yield* thrownOutcome(err);
  }
}
