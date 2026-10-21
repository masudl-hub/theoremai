/**
 * One Web-standard handler that serves a host profile's tools to MCP clients over
 * Streamable HTTP, at one endpoint that takes POST.
 *
 * - Clients on the current revision (`2026-07-28`) send each request with its version and
 *   capabilities in `_meta`; nothing is kept between requests.
 * - Clients on an earlier revision open with `initialize`; the handler answers it and serves
 *   them the same way, without a session.
 *
 * Every call runs through the kernel as a host call does: the profile's gates, guardrails and
 * trace. The client reads what a model would: the call's guarded text, never its raw output.
 *
 * @module
 */

import {
  invokeTool,
  labelText,
  type Profile,
  registerProfile,
  type TurnEvent,
} from '@theoremjs/agents';
import { type ClientTurnOptions, caughtStatus, clientError } from '@theoremjs/agents/host';
import { hostInterface } from '../client/host-transport.ts';
import { defineHostProfile, hostTool, type TheoremHostHandlerOptions } from './handler.ts';
import { boundedRequestJson, requestByteLimit } from './request-body.ts';

type HostProfile = Extract<Profile, { type: 'host' }>;
type CompletedCall = Extract<Extract<TurnEvent, { type: 'tool' }>['tool'], { phase: 'complete' }>;
type ResultPart = NonNullable<CompletedCall['parts']>[number];

export type TheoremMcpHandlerOptions = {
  /** Host profile to serve. Registered with the kernel when the handler is created. */
  profile: TheoremHostHandlerOptions['profile'];
  /** The server's version, as clients show it. */
  version: string;
  /** The server's name, as clients show it. Defaults to the profile's id. */
  name?: string;
  /** How a model should use these tools; clients may add it to the model's context. */
  instructions?: string;
  /**
   * Origins a browser page may call from, besides the endpoint's own. A request whose
   * `Origin` is neither is refused with 403, as MCP requires against DNS rebinding.
   */
  origins?: readonly string[];
  /** Handed to each tool as `ctx.host`. */
  host?: (request: Request) => unknown;
  /** Largest request body read, in bytes. */
  maxRequestBytes?: number;
  /** Who reads this host's replies: forwarded to `clientError` for a failure the handler catches. */
  clientEvents?: ClientTurnOptions;
  /** Called with any error the handler catches, for reporting. */
  onError?: (err: unknown, ctx: { request: Request }) => void;
};

/** The revision that carries its version on every request. */
const MODERN_VERSION = '2026-07-28';
/** Revisions that open with `initialize`, newest first. */
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
/**
 * How long a current-revision client may keep each cacheable result, in milliseconds. Neither
 * holds anything of the caller's, so any cache may share them.
 */
const CACHED: Partial<Record<string, number>> = {
  'server/discover': 3_600_000,
  'tools/list': 300_000,
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

type Id = string | number | null;
type RpcRequest = { id?: string | number; method: string; params: Record<string, unknown> };
type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
};
type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };
type CallResult = { content: McpContent[]; isError: boolean };

class RpcError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function rpcError(id: Id, error: RpcError): Response {
  return reply(error.status, {
    jsonrpc: '2.0',
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON-RPC message in `body`; one message per POST, never a batch or a response. */
function rpcRequest(body: unknown): RpcRequest {
  if (
    !isRecord(body) ||
    body.jsonrpc !== '2.0' ||
    typeof body.method !== 'string' ||
    (body.id !== undefined && typeof body.id !== 'string' && typeof body.id !== 'number') ||
    (body.params !== undefined && !isRecord(body.params))
  )
    // labels-exempt: protocol diagnostic for the MCP client, not end-user copy
    throw new RpcError(400, INVALID_REQUEST, 'Invalid request');
  return {
    ...(body.id !== undefined ? { id: body.id } : {}),
    method: body.method,
    params: isRecord(body.params) ? body.params : {},
  };
}

/** A mirrored header's value, decoded from the `=?base64?…?=` form MCP uses for unsafe values. */
function headerValue(value: string): string {
  const encoded = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!encoded) return value;
  const bytes = Uint8Array.from(atob(encoded[1]), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The current revision's request checks: a version this server speaks, the capabilities the
 * client declares, and headers that agree with the body they mirror.
 */
function checkModern(request: Request, message: RpcRequest, meta: Record<string, unknown>): void {
  const version = meta[META_VERSION];
  if (version !== MODERN_VERSION)
    // labels-exempt: protocol diagnostic for the MCP client, not end-user copy
    throw new RpcError(400, UNSUPPORTED_VERSION, 'Unsupported protocol version', {
      supported: SUPPORTED_VERSIONS,
      requested: version,
    });
  if (!isRecord(meta[META_CAPABILITIES]))
    // labels-exempt: protocol diagnostic for the MCP client, not end-user copy
    throw new RpcError(400, INVALID_PARAMS, `Missing _meta field ${META_CAPABILITIES}`);
  const mirrored: [string, unknown][] = [
    ['mcp-protocol-version', version],
    ['mcp-method', message.method],
  ];
  if (message.method === 'tools/call') mirrored.push(['mcp-name', message.params.name]);
  for (const [name, body] of mirrored) {
    const header = request.headers.get(name);
    if (header === null || headerValue(header) !== body)
      // labels-exempt: protocol diagnostic for the MCP client, not end-user copy
      throw new RpcError(400, HEADER_MISMATCH, `Header mismatch: ${name}`);
  }
}

/** The legacy revision a client asked for in `initialize`, or the newest one this server speaks. */
function legacyVersion(params: Record<string, unknown>): string {
  const asked = params.protocolVersion;
  return LEGACY_VERSIONS.find((version) => version === asked) ?? LEGACY_VERSIONS[0];
}

/** What the client reads of one call, from the kernel's events for it. */
function callResult(events: TurnEvent[], labels: HostProfile['labels']): CallResult {
  for (const event of events) {
    if (event.type === 'error')
      return {
        content: [
          { type: 'text', text: event.error ?? labelText(`error.${event.errorKind}`, {}, labels) },
        ],
        isError: true,
      };
    if (event.type !== 'tool' || !('phase' in event.tool)) continue;
    const tool = event.tool;
    if (tool.phase === 'complete')
      return {
        content: [
          { type: 'text', text: tool.readBack ?? '' },
          ...(tool.parts ?? []).map(partContent),
        ],
        isError: false,
      };
    if (tool.phase === 'error')
      return {
        content: [{ type: 'text', text: tool.readBack ?? tool.failure.message }],
        isError: true,
      };
    // why: No one can answer a gate here; the client reads why the call stopped, as a model would.
    if (tool.phase === 'gate')
      return {
        content: [{ type: 'text', text: tool.readBack ?? labelText('error.blocked', {}, labels) }],
        isError: true,
      };
  }
  return {
    content: [{ type: 'text', text: labelText('error.internal', {}, labels) }],
    isError: true,
  };
}

function partContent(part: ResultPart, index: number): McpContent {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if ('uri' in part)
    return { type: 'resource_link', uri: part.uri, name: part.uri, mimeType: part.mimeType };
  if (part.type === 'image' || part.type === 'audio')
    return { type: part.type, data: part.data, mimeType: part.mimeType };
  return {
    type: 'resource',
    resource: { uri: `part:${index}`, mimeType: part.mimeType, blob: part.data },
  };
}

/** Same origin, or one the host lists; a request with no `Origin` is not from a page. */
function originAllowed(request: Request, origins: readonly string[]): boolean {
  const origin = request.headers.get('origin');
  return origin === null || origin === new URL(request.url).origin || origins.includes(origin);
}

/**
 * Serves a host profile's tools to MCP clients. Every tool the profile allows must run
 * without a person's approval: an MCP client has no one to ask.
 */
export function createTheoremMcpHandler(
  options: TheoremMcpHandlerOptions,
): (request: Request) => Promise<Response> {
  const host = defineHostProfile('createTheoremMcpHandler', options.profile);
  for (const name of host.tools.allow) {
    const permission = hostTool(name)?.permission;
    if (permission !== undefined && permission !== 'auto') {
      // labels-exempt: builder config error at setup; no user sees it
      throw new Error(
        `createTheoremMcpHandler serves tools that run without approval; '${name}' has permission '${permission}'.`,
      );
    }
  }
  const maxBytes = requestByteLimit(options.maxRequestBytes);
  registerProfile(host);
  const serverInfo = { name: options.name ?? host.id, version: options.version };
  const instructions = options.instructions ? { instructions: options.instructions } : {};

  const listed = (): McpTool[] =>
    hostInterface(host, hostTool).tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: tool.access === 'read-only',
        ...(tool.access === 'destructive' ? { destructiveHint: true } : {}),
      },
    }));

  async function call(request: Request, params: Record<string, unknown>): Promise<CallResult> {
    const name = params.name;
    if (typeof name !== 'string' || !listed().some((tool) => tool.name === name))
      // labels-exempt: protocol diagnostic for the MCP client, not end-user copy
      throw new RpcError(200, INVALID_PARAMS, `Unknown tool: ${String(name)}`);
    const events: TurnEvent[] = [];
    for await (const event of invokeTool({
      profile: host.id,
      name,
      input: params.arguments ?? {},
      signal: request.signal,
      host: await options.host?.(request),
    }))
      events.push(event);
    return callResult(events, host.labels);
  }

  async function result(
    request: Request,
    message: RpcRequest,
    modern: boolean,
  ): Promise<Record<string, unknown>> {
    switch (message.method) {
      case 'server/discover':
        if (!modern) break;
        return {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          ...instructions,
        };
      case 'initialize':
        if (modern) break;
        return {
          protocolVersion: legacyVersion(message.params),
          capabilities: { tools: {} },
          serverInfo,
          ...instructions,
        };
      case 'ping':
        if (modern) break;
        return {};
      case 'tools/list':
        return { tools: listed() };
      case 'tools/call':
        return await call(request, message.params);
    }
    // labels-exempt: protocol diagnostic for the MCP client, not end-user copy
    throw new RpcError(modern ? 404 : 200, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }

  return async (request) => {
    if (!originAllowed(request, options.origins ?? []))
      // labels-exempt: protocol diagnostic for the MCP client, not end-user copy
      return rpcError(null, new RpcError(403, INVALID_REQUEST, 'Origin not allowed'));
    if (request.method !== 'POST')
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    let id: Id = null;
    try {
      let body: unknown;
      try {
        body = await boundedRequestJson(request, maxBytes);
      } catch (err) {
        if (err instanceof SyntaxError)
          // labels-exempt: protocol diagnostic for the MCP client, not end-user copy
          throw new RpcError(400, PARSE_ERROR, 'Parse error');
        throw err;
      }
      const message = rpcRequest(body);
      id = message.id ?? null;
      const meta = isRecord(message.params._meta) ? message.params._meta : {};
      const modern = META_VERSION in meta;
      if (modern) checkModern(request, message, meta);
      else if (request.headers.get('mcp-protocol-version') === MODERN_VERSION)
        // labels-exempt: protocol diagnostic for the MCP client, not end-user copy
        throw new RpcError(400, INVALID_PARAMS, `Missing _meta field ${META_VERSION}`);
      // invariant: A notification has no reply; the client needs only to know it arrived.
      if (message.id === undefined) return new Response(null, { status: 202 });
      const answered = await result(request, message, modern);
      const ttlMs = CACHED[message.method];
      return reply(200, {
        jsonrpc: '2.0',
        id: message.id,
        result: modern
          ? {
              resultType: 'complete',
              ...answered,
              ...(ttlMs !== undefined ? { ttlMs, cacheScope: 'public' } : {}),
              _meta: { [META_SERVER]: serverInfo },
            }
          : answered,
      });
    } catch (err) {
      if (err instanceof RpcError) return rpcError(id, err);
      options.onError?.(err, { request });
      const failure = clientError(err, host.labels, options.clientEvents);
      const code = failure.errorKind === 'request' ? INVALID_REQUEST : INTERNAL_ERROR;
      return rpcError(id, new RpcError(caughtStatus(err), code, failure.error));
    }
  };
}
