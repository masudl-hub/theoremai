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

import { assertSafeUrl } from '../../guardrails/network.ts';
import { refreshOAuthToken } from '../auth/oauth.ts';
import type { TurnEvent } from '../types.ts';
import type {
  HttpToolAuthConfig,
  HttpToolDef,
  McpToolDef,
  ModelToolResult,
  ToolCallEvent,
  ToolContext,
  ToolFailure,
  ToolPause,
} from './types.ts';

function toolEvent(
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  patch: Partial<ToolCallEvent>,
): TurnEvent {
  return {
    type: 'tool',
    tool: {
      ...base,
      ...patch,
    },
  };
}

function failureEvent(
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
  failure: ToolFailure,
): TurnEvent {
  return toolEvent(base, { phase: 'error', failure });
}

/**
 * Resolves credentials and handles missing/expired tokens.
 * Yields TurnEvents for auth pauses or progress (e.g. refreshed tokens).
 */
export async function* resolveToolAuth(
  toolName: string,
  authConfig: HttpToolAuthConfig | undefined,
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
): AsyncGenerator<
  TurnEvent,
  { headers: Record<string, string>; unauthenticated?: boolean; modelMessage?: string }
> {
  if (!authConfig) {
    return { headers: {} };
  }

  const slot = authConfig.slot;
  const credential = ctx.credentials?.[slot];
  const policy = authConfig.onUnauthenticated ?? 'pause';

  if (!credential) {
    const message = `Authentication required for '${toolName}' (auth slot: '${slot}').`;
    if (policy === 'pause') {
      const authPause: ToolPause = {
        kind: 'auth',
        tool: toolName,
        input: base.arguments,
        authChallenge: {
          slot,
          authType: authConfig.type,
          message,
          issuer: authConfig.preResolved?.issuer,
          resource: authConfig.preResolved?.resource,
          requiredScopes: authConfig.scopes,
        },
      };
      yield toolEvent(base, { phase: 'pause', pause: authPause });
      return { headers: {}, unauthenticated: true };
    }
    return { headers: {}, unauthenticated: true, modelMessage: message };
  }

  // Handle Bearer Token
  if (credential.type === 'bearer') {
    const headerName = authConfig.headerName ?? 'Authorization';
    const headerPrefix = authConfig.headerPrefix ?? 'Bearer ';
    return { headers: { [headerName]: `${headerPrefix}${credential.token}` } };
  }

  // Handle API Key
  if (credential.type === 'api_key') {
    const headerName = credential.headerName ?? authConfig.headerName ?? 'Authorization';
    const headerPrefix = credential.headerPrefix ?? authConfig.headerPrefix ?? '';
    return { headers: { [headerName]: `${headerPrefix}${credential.key}` } };
  }

  // Handle OAuth 2.1
  if (credential.type === 'oauth2') {
    let activeToken = credential.accessToken;
    const now = Date.now();
    const isExpired = credential.expiresAt !== undefined && credential.expiresAt <= now + 30000; // 30s buffer

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

        // Emit progress event notifying host that token was refreshed
        yield toolEvent(base, {
          phase: 'progress',
          data: {
            kind: 'auth_token_refreshed',
            slot,
            credential: refreshResult.credential,
          },
        });

        // Mutate in-memory context credentials for subsequent steps in this turn
        if (ctx.credentials) {
          ctx.credentials[slot] = refreshResult.credential;
        }
      } catch (err) {
        const message = `Failed to refresh OAuth token for '${toolName}' (slot: '${slot}'): ${err instanceof Error ? err.message : String(err)}`;
        if (policy === 'pause') {
          const authPause: ToolPause = {
            kind: 'auth',
            tool: toolName,
            input: base.arguments,
            authChallenge: {
              slot,
              authType: 'oauth2',
              message,
              issuer: credential.issuer,
              resource: credential.resource,
              requiredScopes: authConfig.scopes,
            },
          };
          yield toolEvent(base, { phase: 'pause', pause: authPause });
          return { headers: {}, unauthenticated: true };
        }
        return { headers: {}, unauthenticated: true, modelMessage: message };
      }
    } else if (isExpired && !credential.refreshToken) {
      const message = `OAuth token expired for '${toolName}' (slot: '${slot}') and no refresh token is available.`;
      if (policy === 'pause') {
        const authPause: ToolPause = {
          kind: 'auth',
          tool: toolName,
          input: base.arguments,
          authChallenge: {
            slot,
            authType: 'oauth2',
            message,
            issuer: credential.issuer,
            resource: credential.resource,
            requiredScopes: authConfig.scopes,
          },
        };
        yield toolEvent(base, { phase: 'pause', pause: authPause });
        return { headers: {}, unauthenticated: true };
      }
      return { headers: {}, unauthenticated: true, modelMessage: message };
    }

    const headerName = authConfig.headerName ?? 'Authorization';
    const headerPrefix = authConfig.headerPrefix ?? 'Bearer ';
    return { headers: { [headerName]: `${headerPrefix}${activeToken}` } };
  }

  return { headers: {} };
}

/**
 * Executes a Declarative HTTP tool.
 */
export async function* executeHttpTool(
  tool: HttpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
): AsyncGenerator<TurnEvent, ModelToolResult | undefined> {
  yield toolEvent(base, { phase: 'running' });

  // 1. Input validation
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    yield failureEvent(base, {
      code: 'invalid_input',
      message: 'Tool input validation failed',
      details: parsed.error.flatten(),
    });
    return undefined;
  }
  const input = parsed.data as Record<string, unknown>;

  // 2. Auth resolution
  const authRes = yield* resolveToolAuth(tool.name, tool.auth, ctx, base);
  if (authRes.unauthenticated) {
    if (authRes.modelMessage) {
      return { finding: authRes.modelMessage };
    }
    return undefined; // Turn paused
  }

  // 3. Build endpoint URL with path and query parameters
  let urlStr = tool.endpoint;
  const pathParams = tool.mapping?.pathParams ?? [];
  for (const param of pathParams) {
    const val = input[param];
    if (val !== undefined) {
      urlStr = urlStr.replaceAll(`{${param}}`, encodeURIComponent(String(val)));
    }
  }

  const unreplacedMatch = urlStr.match(/\{([a-zA-Z0-9_-]+)\}/);
  if (unreplacedMatch) {
    yield failureEvent(base, {
      code: 'invalid_input',
      message: `Missing required path parameter "${unreplacedMatch[1]}" for endpoint "${tool.endpoint}"`,
    });
    return undefined;
  }

  // 4. Validate URL against SSRF network guardrails
  let targetUrl: URL;
  try {
    targetUrl = assertSafeUrl(urlStr, ctx.profile.guardrails?.network);
  } catch (err) {
    yield failureEvent(base, {
      code: 'network_blocked',
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  // Query parameters
  const queryParams = tool.mapping?.queryParams ?? [];
  for (const param of queryParams) {
    const val = input[param];
    if (val !== undefined) {
      targetUrl.searchParams.set(param, String(val));
    }
  }

  // 5. Build request body
  let body: string | undefined;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...tool.headers,
    ...authRes.headers,
  };

  if (tool.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (tool.mapping?.bodyParam) {
      body = JSON.stringify(input[tool.mapping.bodyParam]);
    } else {
      // Exclude path and query params from default body payload
      const bodyObj: Record<string, unknown> = {};
      const excluded = new Set([...pathParams, ...queryParams]);
      for (const [k, v] of Object.entries(input)) {
        if (!excluded.has(k)) {
          bodyObj[k] = v;
        }
      }
      body = JSON.stringify(bodyObj);
    }
  }

  // 6. Execute HTTP call
  try {
    const response = await fetch(targetUrl.toString(), {
      method: tool.method,
      headers,
      body,
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

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    let responseData: unknown = text;
    if (contentType.includes('application/json') && text.trim().length > 0) {
      try {
        responseData = JSON.parse(text);
      } catch {
        responseData = text;
      }
    } else if (text.trim().length === 0 && response.status === 204) {
      responseData = null;
    }

    // 7. Validate output schema
    let checked = tool.output.safeParse(responseData);
    if (!checked.success && typeof responseData === 'string' && responseData.trim().length > 0) {
      try {
        const jsonParsed = JSON.parse(responseData);
        const retryChecked = tool.output.safeParse(jsonParsed);
        if (retryChecked.success) {
          checked = retryChecked;
        }
      } catch {
        // Not JSON
      }
    }

    if (!checked.success) {
      yield failureEvent(base, {
        code: 'invalid_output',
        message: 'HTTP response did not match tool output schema',
        details: checked.error.flatten(),
      });
      return undefined;
    }

    yield toolEvent(base, { phase: 'complete', output: checked.data });
    return {
      finding: typeof checked.data === 'string' ? checked.data : JSON.stringify(checked.data),
      data: checked.data,
    };
  } catch (err) {
    yield failureEvent(base, {
      code: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Executes a Remote MCP tool over Streamable HTTP (spec revision 2026-07-28).
 */
export async function* executeMcpTool(
  tool: McpToolDef,
  rawInput: unknown,
  ctx: ToolContext,
  base: Pick<ToolCallEvent, 'name' | 'callId' | 'arguments'>,
): AsyncGenerator<TurnEvent, ModelToolResult | undefined> {
  yield toolEvent(base, { phase: 'running' });

  // 1. Input validation
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    yield failureEvent(base, {
      code: 'invalid_input',
      message: 'Tool input validation failed',
      details: parsed.error.flatten(),
    });
    return undefined;
  }
  const input = parsed.data;

  // 2. Validate server URL against network guardrail
  let targetUrl: URL;
  try {
    targetUrl = assertSafeUrl(tool.serverUrl, ctx.profile.guardrails?.network);
  } catch (err) {
    yield failureEvent(base, {
      code: 'network_blocked',
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  // 3. Resolve Auth
  const authRes = yield* resolveToolAuth(tool.name, tool.auth, ctx, base);
  if (authRes.unauthenticated) {
    if (authRes.modelMessage) {
      return { finding: authRes.modelMessage };
    }
    return undefined; // Turn paused
  }

  // 4. Construct MCP JSON-RPC `tools/call` payload per 2026-07-28 spec
  const jsonRpcPayload = {
    jsonrpc: '2.0',
    id: base.callId ?? Date.now(),
    method: 'tools/call',
    params: {
      name: tool.mcpToolName,
      arguments: input,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      },
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'MCP-Protocol-Version': '2026-07-28',
    ...authRes.headers,
  };

  try {
    const response = await fetch(targetUrl.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(jsonRpcPayload),
      signal: ctx.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      yield failureEvent(base, {
        code: `mcp_http_${response.status}`,
        message: `MCP server error HTTP ${response.status}: ${errText}`,
      });
      return undefined;
    }

    const text = await response.text();
    let rpcResponse: {
      jsonrpc?: string;
      result?: {
        content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
        isError?: boolean;
      };
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      rpcResponse = JSON.parse(text);
    } catch {
      yield failureEvent(base, {
        code: 'invalid_response',
        message: `MCP server returned non-JSON response: ${text.slice(0, 200)}`,
      });
      return undefined;
    }

    if (rpcResponse.error) {
      yield failureEvent(base, {
        code: `mcp_rpc_error_${rpcResponse.error.code}`,
        message: rpcResponse.error.message,
        details: rpcResponse.error.data,
      });
      return undefined;
    }

    const result = rpcResponse.result;
    if (result?.isError) {
      const errText =
        result.content?.map((c) => c.text ?? '').join('\n') ?? 'MCP Tool execution error';
      yield failureEvent(base, {
        code: 'mcp_tool_execution_failed',
        message: errText,
      });
      return undefined;
    }

    // Extract text content or structured data
    let output: unknown;
    if (result?.content && Array.isArray(result.content)) {
      output = result.content.map((c) => c.text ?? '').join('\n');
    } else {
      output = result;
    }

    let checked = tool.output.safeParse(output);
    if (!checked.success && typeof output === 'string' && output.trim().length > 0) {
      try {
        const jsonParsed = JSON.parse(output);
        const retryChecked = tool.output.safeParse(jsonParsed);
        if (retryChecked.success) {
          checked = retryChecked;
        }
      } catch {
        // Not JSON
      }
    }

    if (!checked.success) {
      yield failureEvent(base, {
        code: 'invalid_output',
        message: 'MCP output schema validation failed',
        details: checked.error.flatten(),
      });
      return undefined;
    }

    yield toolEvent(base, { phase: 'complete', output: checked.data });
    return {
      finding: typeof checked.data === 'string' ? checked.data : JSON.stringify(checked.data),
      data: checked.data,
    };
  } catch (err) {
    yield failureEvent(base, {
      code: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
