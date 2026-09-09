/**
 * Execution runners for Declarative HTTP and Remote MCP tools.
 *
 * Implements:
 * - URL parameter substitution and query/body mapping
 * - Network SSRF guardrail enforcement via `assertSafeUrl`
 * - Credential resolution (bearer, api_key, oauth2)
 * - Proactive OAuth token refresh with progress event emission
 * - ToolPause { kind: 'auth' } emission or model error reporting
 * - Streamable HTTP MCP JSON-RPC protocol (`tools/call`) per 2026-07-28 spec
 *
 * @module
 */

import { refreshOAuthToken } from '../auth/oauth.ts';
import type { OAuth2Credential, ToolCredential } from '../auth/types.ts';
import type { TurnEvent } from '../types.ts';
import {
  failureEvent,
  guardToolTarget,
  messageOf,
  startToolExecution,
  type ToolCallBase,
  toolEvent,
} from './events.ts';
import type {
  HttpToolAuthConfig,
  HttpToolDef,
  McpToolDef,
  ModelToolResult,
  ToolContext,
  ToolFailure,
  ToolPause,
} from './types.ts';

export type AuthResolveResult = {
  headers: Record<string, string>;
  unauthenticated?: boolean;
  modelMessage?: string;
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

function buildAuthPause(
  toolName: string,
  authConfig: HttpToolAuthConfig,
  base: ToolCallBase,
  message: string,
  extras?: { issuer?: string; resource?: string },
): ToolPause {
  return {
    kind: 'auth',
    tool: toolName,
    input: base.arguments,
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

function* yieldUnauthenticated(
  toolName: string,
  authConfig: HttpToolAuthConfig,
  base: ToolCallBase,
  message: string,
  policy: string,
  extras?: { issuer?: string; resource?: string },
): Generator<TurnEvent, AuthResolveResult> {
  if (policy === 'pause') {
    yield toolEvent(base, {
      phase: 'pause',
      pause: buildAuthPause(toolName, authConfig, base, message, extras),
    });
    return { headers: {}, unauthenticated: true };
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
    };
  }
  if (credential.type === 'api_key') {
    const headerName = credential.headerName ?? authConfig.headerName ?? 'Authorization';
    const headerPrefix = credential.headerPrefix ?? authConfig.headerPrefix ?? '';
    return { headers: { [headerName]: `${headerPrefix}${credential.key}` } };
  }
  return undefined;
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
  let activeToken = credential.accessToken;
  const now = Date.now();
  const isExpired = credential.expiresAt !== undefined && credential.expiresAt <= now + 30000;

  if (isExpired && credential.refreshToken) {
    try {
      const refreshResult = await refreshOAuthToken({
        refreshToken: credential.refreshToken,
        tokenEndpoint: credential.tokenEndpoint,
        clientId: credential.clientId,
        resource: credential.resource,
        scope: credential.scope,
        issuer: credential.issuer,
      });
      activeToken = refreshResult.credential.accessToken;
      yield toolEvent(base, {
        phase: 'progress',
        data: {
          kind: 'auth_token_refreshed',
          slot,
          credential: refreshResult.credential,
        },
      });
      if (ctx.credentials) {
        ctx.credentials[slot] = refreshResult.credential;
      }
    } catch (err) {
      const message = `Failed to refresh OAuth token for '${toolName}' (slot: '${slot}'): ${err instanceof Error ? err.message : String(err)}`;
      return yield* yieldUnauthenticated(toolName, authConfig, base, message, policy, {
        issuer: credential.issuer,
        resource: credential.resource,
      });
    }
  } else if (isExpired && !credential.refreshToken) {
    const message = `OAuth token expired for '${toolName}' (slot: '${slot}') and no refresh token is available.`;
    return yield* yieldUnauthenticated(toolName, authConfig, base, message, policy, {
      issuer: credential.issuer,
      resource: credential.resource,
    });
  }

  return {
    headers: authHeaderPair(authConfig, activeToken, {
      headerName: 'Authorization',
      headerPrefix: 'Bearer ',
    }),
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
    const message = `Authentication required for '${toolName}' (auth slot: '${authConfig.slot}').`;
    return yield* yieldUnauthenticated(toolName, authConfig, base, message, policy);
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
  let urlStr = endpoint;
  const pathParams = mapping?.pathParams ?? [];
  for (const param of pathParams) {
    const val = input[param];
    if (val !== undefined) {
      urlStr = urlStr.replaceAll(`{${param}}`, encodeURIComponent(String(val)));
    }
  }

  const unreplacedMatch = urlStr.match(/\{([a-zA-Z0-9_-]+)\}/);
  if (unreplacedMatch) {
    throw new Error(
      `Missing required path parameter "${unreplacedMatch[1]}" for endpoint "${endpoint}"`,
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

function parseToolOutput<T>(
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

function modelResultFromOutput(data: unknown): ModelToolResult {
  return {
    finding: typeof data === 'string' ? data : JSON.stringify(data),
    data,
  };
}

/**
 * Executes a Declarative HTTP tool.
 */
export async function* executeHttpTool(
  tool: HttpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
): AsyncGenerator<TurnEvent, ModelToolResult | undefined> {
  const started = yield* startToolExecution(tool, rawInput, ctx, base);
  if (!started.ok) {
    return undefined;
  }
  const input = started.data as Record<string, unknown>;

  const authRes = yield* resolveToolAuth(tool.name, tool.auth, ctx, base);
  if (authRes.unauthenticated) {
    return authRes.modelMessage ? { finding: authRes.modelMessage } : undefined;
  }

  let target: HttpToolTarget;
  try {
    target = buildHttpToolTarget(tool.endpoint, tool.method, input, tool.mapping);
  } catch (err) {
    yield failureEvent(base, { code: 'invalid_input', message: messageOf(err) });
    return undefined;
  }

  const targetUrl = yield* guardToolTarget(target.url, ctx, base);
  if (!targetUrl) {
    return undefined;
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...tool.headers,
    ...authRes.headers,
  };
  if (tool.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      method: tool.method,
      headers,
      body: target.body,
      signal: ctx.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      yield failureEvent(base, {
        code: `http_${response.status}`,
        message: `HTTP ${response.status} from ${targetUrl.hostname}: ${errText}`,
      });
      return undefined;
    }

    const text = await response.text();
    const responseData = parseHttpResponseData(
      response.headers.get('content-type') ?? '',
      text,
      response.status,
    );
    const checked = parseToolOutput(tool.output, responseData);
    if (!checked.success) {
      yield failureEvent(base, {
        code: 'invalid_output',
        message: 'HTTP response did not match tool output schema',
        details: checked.error.flatten(),
      });
      return undefined;
    }

    yield toolEvent(base, { phase: 'complete', output: checked.data });
    return modelResultFromOutput(checked.data);
  } catch (err) {
    yield failureEvent(base, {
      code: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Preferred-first Streamable HTTP protocol revisions the kernel will negotiate. */
export const MCP_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
] as const;

export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

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
    throw new Error(`MCP server returned non-JSON response: ${text.slice(0, 200)}`);
  }
  return last;
}

/** True when a JSON-RPC error indicates the server rejected our protocol revision. */
export function isUnsupportedMcpProtocolError(error: McpRpcResponse['error']): boolean {
  if (!error) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('unsupported protocol version') ||
    message.includes('inconsistent mcp protocol version')
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
  if (text.toLowerCase().includes('unsupported protocol version')) {
    return { code: -32600, message: text.slice(0, 300) };
  }
  return undefined;
}

type McpFetchOutcome =
  | { kind: 'rpc'; response: McpRpcResponse }
  | { kind: 'retry' }
  | { kind: 'protocol_retry'; error: McpRpcResponse['error'] }
  | { kind: 'failure'; failure: ToolFailure };

async function fetchMcpProtocolAttempt(
  targetUrl: string,
  baseHeaders: Record<string, string>,
  rpcId: string | number,
  mcpToolName: string,
  input: unknown,
  protocolVersion: string,
  signal: AbortSignal | undefined,
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

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'MCP-Protocol-Version': protocolVersion,
    },
    body: JSON.stringify(jsonRpcPayload),
    signal,
  });

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
        message: `MCP server error HTTP ${response.status}: ${text.slice(0, 300)}`,
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
        message: `MCP server returned non-JSON response: ${text.slice(0, 200)}`,
      },
    };
  }
}

async function negotiateMcpRpc(
  targetUrl: string,
  baseHeaders: Record<string, string>,
  rpcId: string | number,
  mcpToolName: string,
  input: unknown,
  signal: AbortSignal | undefined,
): Promise<{
  rpc?: McpRpcResponse;
  failure?: ToolFailure;
  lastProtocolError?: McpRpcResponse['error'];
}> {
  let lastProtocolError: McpRpcResponse['error'];
  for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
    const outcome = await fetchMcpProtocolAttempt(
      targetUrl,
      baseHeaders,
      rpcId,
      mcpToolName,
      input,
      protocolVersion,
      signal,
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
      message: rpcResponse.error.message,
      details: rpcResponse.error.data,
    };
  }
  const result = rpcResponse.result;
  if (result?.isError) {
    return {
      code: 'mcp_tool_execution_failed',
      message: result.content?.map((c) => c.text ?? '').join('\n') ?? 'MCP Tool execution error',
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
        message: negotiated.lastProtocolError?.message ?? 'MCP protocol negotiation failed',
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
        message: 'MCP output schema validation failed',
        details: checked.error.flatten(),
      },
    };
  }
  return { ok: true, data: checked.data };
}

/**
 * Executes a Remote MCP tool over Streamable HTTP (spec revision 2026-07-28).
 */
export async function* executeMcpTool(
  tool: McpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
): AsyncGenerator<TurnEvent, ModelToolResult | undefined> {
  const started = yield* startToolExecution(tool, rawInput, ctx, base);
  if (!started.ok) {
    return undefined;
  }

  const targetUrl = yield* guardToolTarget(tool.serverUrl, ctx, base);
  if (!targetUrl) {
    return undefined;
  }

  const authRes = yield* resolveToolAuth(tool.name, tool.auth, ctx, base);
  if (authRes.unauthenticated) {
    return authRes.modelMessage ? { finding: authRes.modelMessage } : undefined;
  }

  try {
    const interpreted = interpretMcpRpc(
      tool,
      await negotiateMcpRpc(
        targetUrl.toString(),
        {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...tool.headers,
          ...authRes.headers,
        },
        base.callId ?? Date.now(),
        tool.mcpToolName,
        started.data,
        ctx.signal,
      ),
    );
    if (!interpreted.ok) {
      yield failureEvent(base, interpreted.failure);
      return undefined;
    }
    yield toolEvent(base, { phase: 'complete', output: interpreted.data });
    return modelResultFromOutput(interpreted.data);
  } catch (err) {
    yield failureEvent(base, {
      code: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
