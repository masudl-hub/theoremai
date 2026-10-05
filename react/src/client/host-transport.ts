/**
 * The browser side of a host profile: the tools the host lets the page call,
 * each with the schemas its request and response are drawn from, and the calls
 * themselves, streamed as the kernel runs them.
 *
 * @module
 */

import {
  type Profile,
  resolveObservabilityPolicy,
  TOOL_ACCESS,
  TOOL_PERMISSION,
  type ToolAccess,
  type ToolPermission,
  TURN_EVENT_SCHEMAS,
  z,
} from '@theoremjs/agents';
import type { Equals } from '@theoremjs/agents/kernel';
import type { TraceFeed } from './trace-feed.ts';
import {
  fetchJson,
  type HttpOptions,
  postNdjson,
  type TheoremInvokeRequest,
  type TurnEventSink,
} from './transport.ts';
import { checkWire } from './wire-line.ts';

/** How a tool reaches its work: a function on the host, an HTTP endpoint, or an MCP server. */
export const HOST_TOOL_KINDS = ['function', 'http', 'mcp'] as const;
export type HostToolKind = (typeof HOST_TOOL_KINDS)[number];

/** One tool as the page sees it. Its endpoint, headers, and credentials stay on the host. */
export type HostToolView = {
  name: string;
  description: string;
  kind: HostToolKind;
  access: ToolAccess;
  permission: ToolPermission;
  /** JSON Schema for the call's input: the form is drawn from it. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the tool's output: the result is laid out from it. */
  outputSchema: Record<string, unknown>;
};

/** What a host profile shows the page. */
export type HostInterface = {
  type: 'host';
  id: string;
  tools: HostToolView[];
  observability?: { record: boolean };
};

/** A tool as registered: the fields the page's view keeps. */
export type HostToolSource = {
  type: string;
  name: string;
  description: string;
  access: ToolAccess;
  permission: ToolPermission;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

function isHostToolKind(type: string): type is HostToolKind {
  return (HOST_TOOL_KINDS as readonly string[]).includes(type);
}

/** The page's view of a host profile: its allowed tools, in the order it allows them. */
export function hostInterface(
  profile: Pick<Extract<Profile, { type: 'host' }>, 'id' | 'tools' | 'observability'>,
  tools: (name: string) => HostToolSource | undefined,
): HostInterface {
  return {
    type: 'host',
    id: profile.id,
    tools: profile.tools.allow.flatMap((name) => {
      const tool = tools(name);
      if (!tool || !isHostToolKind(tool.type)) return [];
      return [
        {
          name: tool.name,
          description: tool.description,
          kind: tool.type,
          access: tool.access,
          permission: tool.permission,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
        },
      ];
    }),
    ...(profile.observability
      ? { observability: { record: resolveObservabilityPolicy(profile.observability).record } }
      : {}),
  };
}

/** One call of one of the host's tools. */
export type TheoremHostCallRequest = { name: string; input: unknown };
const theoremHostCallRequest = z.object({ name: z.string().min(1).max(128), input: z.unknown() });
true satisfies Equals<z.infer<typeof theoremHostCallRequest>, TheoremHostCallRequest>;
/** A `/call` body as `createTheoremHostHandler` reads it. */
export const theoremHostCallRequestSchema: z.ZodType<TheoremHostCallRequest> =
  theoremHostCallRequest;

export interface HostTransport {
  describe(signal?: AbortSignal): Promise<HostInterface>;
  /** Runs one tool; its events stream to `onEvent`, ending in `done`. */
  call(
    request: TheoremHostCallRequest,
    onEvent: TurnEventSink,
    signal?: AbortSignal,
  ): Promise<void>;
  /** The user's answer to a call the host paused on a gate. */
  invoke(
    request: TheoremInvokeRequest,
    onEvent: TurnEventSink,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Where the host's trace records land, for the inspector. */
  traces?: TraceFeed;
}

const schemaObject = z.record(z.string(), z.unknown());
const describedSchema = z.object({
  interface: z.object({
    type: z.literal('host'),
    id: z.string(),
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        kind: z.enum(HOST_TOOL_KINDS),
        access: z.enum(TOOL_ACCESS),
        permission: z.enum(TOOL_PERMISSION),
        inputSchema: schemaObject,
        outputSchema: schemaObject,
      }),
    ),
    observability: z.object({ record: z.boolean() }).optional(),
  }),
});

/** Transport for a host mounted with `createTheoremHostHandler`. Default endpoint `/api/host`. */
export function createHostTransport(
  options: HttpOptions & { endpoint?: string } = {},
): HostTransport {
  const base = (options.endpoint ?? '/api/host').replace(/\/$/, '');
  return {
    async describe(signal) {
      // lexicon-exempt: internal diagnostic; the user reads error.bad_response
      return checkWire(
        describedSchema,
        await fetchJson(base, { signal }, options),
        'the host description',
      ).interface;
    },
    call: (body, onEvent, signal) =>
      postNdjson(`${base}/call`, body, TURN_EVENT_SCHEMAS, onEvent, { ...options, signal }),
    invoke: ({ replay: _replay, ...body }, onEvent, signal) =>
      postNdjson(`${base}/invoke`, body, TURN_EVENT_SCHEMAS, onEvent, { ...options, signal }),
  };
}
