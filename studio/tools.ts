/**
 * Function tools answer with the builder's sample reply, else the handler the host gives for their
 * name, else a stub shaped by their output schema.
 */

import type { KernelRegistry, Profile } from '@theoremjs/agents';
import type { ToolRegistry } from '@theoremjs/agents/kernel';
import { GOOGLE_BUILTIN_TOOLS, OPENROUTER_BUILTIN_TOOLS } from './cookbooks/providers.ts';
import { cookbookToolSources } from './cookbooks/sources.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import { stubOutputFromSchema } from './stub.ts';
import { zodFromJsonSchema } from './tool-schema.ts';

/** Adds the cookbook `sources` hook when `name` cites what it returns. */
function citing<T>(name: string, registration: T): T {
  const sources = cookbookToolSources(name);
  return sources ? { ...registration, sources } : registration;
}

/** Answers a function tool's call, for a host that runs its own tools in the studio. */
export type StudioToolHandler = (input: Record<string, unknown>) => Record<string, unknown>;

/** The host's handlers, by tool name. */
export type StudioToolHandlers = Readonly<Record<string, StudioToolHandler>>;

/** Registers one studio tool, its schemas read as the file Save writes reads them. */
export function registerCustomTool(
  tools: ToolRegistry,
  tool: ToolRegistration,
  handlers: StudioToolHandlers = {},
): void {
  const base = {
    name: tool.name,
    description: tool.description,
    category: tool.category,
    access: tool.access,
    paths: tool.paths,
    loadTier: tool.loadTier,
    permission: tool.permission,
    ...(tool.labels ? { labels: tool.labels } : {}),
    ...(tool.after ? { after: true } : {}),
  };
  if (tool.type === 'agent') {
    tools.register({
      ...base,
      type: 'agent',
      profile: tool.profile,
      ...(tool.maxCallsPerTurn !== undefined ? { maxCallsPerTurn: tool.maxCallsPerTurn } : {}),
    });
    return;
  }
  const shared = {
    ...base,
    input: zodFromJsonSchema(tool.inputSchema),
    output: zodFromJsonSchema(tool.outputSchema),
  };
  if (tool.type === 'http') {
    tools.register(
      citing(tool.name, {
        ...shared,
        type: 'http',
        endpoint: tool.endpoint,
        method: tool.method,
        headers: tool.headers,
        mapping: tool.mapping,
        auth: tool.auth,
        maxResponseBytes: tool.maxResponseBytes,
      }),
    );
    return;
  }
  if (tool.type === 'mcp') {
    tools.register(
      citing(tool.name, {
        ...shared,
        type: 'mcp',
        serverUrl: tool.serverUrl,
        mcpToolName: tool.mcpToolName,
        headers: tool.headers,
        auth: tool.auth,
        maxResponseBytes: tool.maxResponseBytes,
        session: tool.session,
      }),
    );
    return;
  }
  if (tool.answeredBy === 'page') {
    tools.register({ ...shared, type: 'function', answeredBy: 'page' });
    return;
  }
  const handler =
    tool.stubResponse || !Object.hasOwn(handlers, tool.name) ? undefined : handlers[tool.name];
  const stub = tool.stubResponse ?? stubOutputFromSchema(tool.outputSchema);
  tools.register({
    ...shared,
    type: 'function',
    handler: handler
      ? (input) => {
          try {
            return Promise.resolve(handler(input as Record<string, unknown>));
          } catch (err) {
            return Promise.reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      : () => Promise.resolve(stub),
  });
}

export function registerStudioTools(
  tools: ToolRegistry,
  customTools: readonly ToolRegistration[],
  handlers?: StudioToolHandlers,
): void {
  tools.registerMany([...GOOGLE_BUILTIN_TOOLS, ...OPENROUTER_BUILTIN_TOOLS]);
  for (const tool of customTools) registerCustomTool(tools, tool, handlers);
}

/** Registers a draft's tools and schema, then its profile, into `registry`. */
export function registerDefined(
  registry: KernelRegistry,
  profile: Profile,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  handlers?: StudioToolHandlers,
): Profile {
  registerStudioTools(registry.tools, customTools, handlers);
  if (structured && profile.type !== 'live') {
    for (const { id, spec } of [structured, ...(structured.also ?? [])]) {
      registry.schemas.register(id, spec);
    }
  }
  registry.profiles.register(profile);
  return profile;
}
