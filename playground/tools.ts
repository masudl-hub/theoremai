/** Function tools run the demo handler for their name, or return a stub shaped by their output schema. */

import type { ToolRegistry } from '../src/kernel/tools/registry.ts';
import { GOOGLE_BUILTIN_TOOLS } from '../src/presets/google.ts';
import { playgroundDemoHandler } from './demo-handlers.ts';
import type { ToolRegistration } from './registrations.ts';
import { stubOutputFromSchema } from './stub.ts';
import { zodFromJsonSchema } from './tool-schema.ts';

function registerCustomTool(tools: ToolRegistry, tool: ToolRegistration): void {
  const shared = {
    name: tool.name,
    description: tool.description,
    category: tool.category,
    access: tool.access,
    paths: tool.paths,
    loadTier: tool.loadTier,
    permission: tool.permission,
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
  const demoHandler = playgroundDemoHandler(tool.name);
  const stub = tool.stubResponse ?? stubOutputFromSchema(tool.outputSchema);
  tools.register({
    ...shared,
    type: 'function',
    handler: demoHandler
      ? (input) => {
          try {
            return Promise.resolve(demoHandler(input as Record<string, unknown>));
          } catch (err) {
            return Promise.reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      : () => Promise.resolve(stub),
  });
}

export function registerPlaygroundTools(
  tools: ToolRegistry,
  customTools: readonly ToolRegistration[],
): void {
  tools.registerMany(GOOGLE_BUILTIN_TOOLS);
  for (const tool of customTools) registerCustomTool(tools, tool);
}
