/**
 * Function tools answer with the builder's sample reply, else the handler the host gives for their
 * name, else a stub shaped by their output schema.
 */

import type { ToolRegistry } from '../src/kernel/tools/registry.ts';
import { GOOGLE_BUILTIN_TOOLS } from '../src/presets/google.ts';
import type { ToolRegistration } from './registrations.ts';
import { stubOutputFromSchema } from './stub.ts';
import { zodFromJsonSchema } from './tool-schema.ts';

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
    tools.register({
      ...shared,
      type: 'http',
      endpoint: tool.endpoint,
      method: tool.method,
      headers: tool.headers,
      mapping: tool.mapping,
      auth: tool.auth,
    });
    return;
  }
  if (tool.type === 'mcp') {
    tools.register({
      ...shared,
      type: 'mcp',
      serverUrl: tool.serverUrl,
      mcpToolName: tool.mcpToolName,
      headers: tool.headers,
      auth: tool.auth,
    });
    return;
  }
  if (tool.answeredBy === 'page') {
    tools.register({ ...shared, type: 'function', answeredBy: 'page' });
    return;
  }
  const handler = tool.stubResponse || !Object.hasOwn(handlers, tool.name) ? undefined : handlers[tool.name];
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
  tools.registerMany(GOOGLE_BUILTIN_TOOLS);
  for (const tool of customTools) registerCustomTool(tools, tool, handlers);
}
