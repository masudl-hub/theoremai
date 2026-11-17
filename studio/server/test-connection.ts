/**
 * Asks a draft HTTP or MCP tool's endpoint one request with the kernel's `probeTool`, so the
 * builder sees whether it answers before a model calls it.
 *
 * @module
 */
import {
  type ProbeToolOptions,
  probeTool,
  type ResolveHost,
  TheoremError,
  type ToolProbe,
  type ToolProbeTarget,
  z,
} from '@theoremjs/agents';
import { caughtStatus, clientError } from '@theoremjs/agents/host';
import type { HttpMethod } from '@theoremjs/agents/schema';
import { readBody } from '@theoremjs/web/server';

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
      /**
       * Arguments for the connection test, never saved.
       *
       * @catalog studio.sampleInput
       */
      sampleInput?: Record<string, unknown>;
      auth?: AuthProbe;
      /**
       * A credential for this tool's connection tests, kept in the tab and never saved.
       *
       * @catalog studio.testCredential
       */
      testCredential?: string;
    }
  | {
      type: 'mcp';
      serverUrl: string;
      mcpToolName?: string;
      headers?: Record<string, string>;
      auth?: AuthProbe;
      /**
       * A credential for this tool's connection tests, kept in the tab and never saved.
       *
       * @catalog studio.testCredential
       */
      testCredential?: string;
    };

function elapsedSince(start: number): number {
  return Date.now() - start;
}

/** How long a test waits for the whole answer, body included. */
const TIMEOUT_MS = 10_000;

/** Why a test got no answer, in the test's own words. */
const UNANSWERED: Record<
  Exclude<Extract<ToolProbe, { verdict: 'unanswered' }>['reason'], 'invalid_mapping'>,
  { code: string; error: string }
> = {
  blocked: {
    code: 'ssrf_blocked',
    error: "The test doesn't call this address. It calls public web addresses only.",
  },
  invalid_url: { code: 'invalid_url', error: "That isn't a web address the test can call." },
  timeout: {
    code: 'network_error',
    error: `No complete response within ${String(TIMEOUT_MS / 1000)} s.`,
  },
  network: {
    code: 'network_error',
    error: "The request didn't get a response. Check that the service is up.",
  },
};

type Inconclusive = Extract<ToolProbe, { verdict: 'inconclusive' }>;

/** Why an answer is neither a yes nor a refusal, in the test's own words; `status` shows the answer itself. */
const INCONCLUSIVE: Record<
  Exclude<Inconclusive['reason'], 'mcp_error'>,
  { code: string; error?: string }
> = {
  status: { code: 'http_status' },
  too_large: { code: 'too_large', error: 'The answer is larger than the test reads.' },
  not_json: { code: 'invalid_json', error: "The MCP server's answer isn't JSON-RPC." },
  not_mcp: {
    code: 'not_mcp',
    error: "Answered, but not as an MCP server: tools/list didn't return a tool list.",
  },
  mcp_session: {
    code: 'mcp_session',
    error: "The MCP server asked for a session and didn't open one.",
  },
};

/** An inconclusive answer's code and words; an MCP error carries the server's own. */
function inconclusiveReason(probe: Inconclusive): { code: string; error?: string } {
  if (probe.reason !== 'mcp_error') return INCONCLUSIVE[probe.reason];
  return probe.error
    ? { code: `mcp_error_${String(probe.error.code)}`, error: probe.error.message }
    : { code: 'mcp_protocol_error', error: 'MCP protocol negotiation failed' };
}

/** The probe, as the test's screen reads it. */
function shownProbe(
  probe: ToolProbe,
  start: number,
  mapping: () => string,
  mcpToolName: string | undefined,
): Response {
  const elapsedMs = elapsedSince(start);
  if (probe.verdict === 'unanswered') {
    const reason =
      probe.reason === 'invalid_mapping'
        ? { code: 'invalid_mapping', error: mapping() }
        : UNANSWERED[probe.reason];
    return Response.json({ ok: false, ...reason, elapsedMs });
  }
  const answer = probe.answer
    ? {
        status: probe.answer.status,
        statusText: probe.answer.statusText,
        contentType: probe.answer.contentType,
        preview: previewResponseBody(probe.answer.body, probe.answer.contentType),
      }
    : {};
  if (probe.verdict === 'refused') {
    return Response.json({
      ok: false,
      ...answer,
      code: 'refused',
      error:
        `The service refused this credential: ${String(probe.answer.status)} ${probe.answer.statusText}`.trim(),
      elapsedMs,
    });
  }
  if (probe.verdict === 'inconclusive') {
    return Response.json({ ok: false, ...answer, ...inconclusiveReason(probe), elapsedMs });
  }
  if (!probe.mcp) return Response.json({ ok: true, ...answer, elapsedMs });
  const targetName = mcpToolName?.trim();
  return Response.json({
    ok: true,
    ...answer,
    protocolVersion: probe.mcp.protocolVersion,
    toolCount: probe.mcp.tools.length,
    tools: probe.mcp.tools,
    targetToolFound: targetName ? probe.mcp.tools.includes(targetName) : undefined,
    elapsedMs,
  });
}

function previewResponseBody(text: string, contentType: string): string {
  if (!contentType.includes('application/json')) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
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

/** The draft's own target for the kernel's probe, or why the request names none. */
function probeTarget(body: TestConnectionRequest): ToolProbeTarget | string {
  if (body.type === 'http') {
    if (typeof body.endpoint !== 'string' || !body.endpoint.trim())
      return 'Endpoint URL is required';
    return {
      type: 'http',
      endpoint: body.endpoint,
      method: (body.method?.toUpperCase() || 'GET') as HttpMethod,
      input: body.sampleInput ?? {},
      mapping: {
        pathParams: body.pathParams,
        queryParams: body.queryParams,
        bodyParam: body.bodyParam,
      },
      ...(body.headers ? { headers: body.headers } : {}),
    };
  }
  if (typeof body.serverUrl !== 'string' || !body.serverUrl.trim()) return 'Server URL is required';
  return {
    type: 'mcp',
    serverUrl: body.serverUrl,
    ...(body.headers ? { headers: body.headers } : {}),
  };
}

/** Where the test credential goes: wherever the kernel would put the tool's own. */
function probeAuth(auth: AuthProbe | undefined): ProbeToolOptions['auth'] {
  if (!auth?.type) return undefined;
  return {
    type: auth.type,
    headerName: auth.headerName?.trim() || undefined,
    headerPrefix: auth.headerPrefix,
    queryParam: auth.queryParam?.trim() || undefined,
  };
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
    const target = probeTarget(body);
    if (typeof target === 'string') {
      return Response.json({ ok: false, error: target }, { status: 400 });
    }
    const auth = probeAuth(body.auth);
    const probe = await probeTool({
      target,
      ...(auth && body.testCredential ? { auth, credential: body.testCredential } : {}),
      ...(options.draftNetwork && network ? { network } : {}),
      ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
      timeoutMs: TIMEOUT_MS,
    });
    const http = body.type === 'http' ? body : undefined;
    return shownProbe(
      probe,
      start,
      () => mappingReason(http?.endpoint ?? '', http?.pathParams ?? [], http?.sampleInput ?? {}),
      body.type === 'mcp' ? body.mcpToolName : undefined,
    );
  } catch (err) {
    return Response.json({ ok: false, ...clientError(err) }, { status: caughtStatus(err) });
  }
}
