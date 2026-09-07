import type { WireFunctionTool } from '../../src/kernel/tools/types.ts';

/** Minimal function tool wire declaration for provider tests. */
function testWireTool(
  name: string,
  partial: Partial<Omit<WireFunctionTool, 'type' | 'name'>> = {},
): WireFunctionTool {
  return {
    type: 'function',
    name,
    description: partial.description ?? '',
    parameters: partial.parameters ?? { type: 'object', properties: {} },
  };
}

export { testWireTool };
