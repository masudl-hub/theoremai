/**
 * THEOREM tool registry and execution.
 *
 * @module
 */

export {
  coerceToolResultParts,
  executeRegisteredTool,
  leanToolResultData,
  projectForModel,
} from './execute.ts';
export { askUserTool, registerHarnessTools } from './harness.ts';
export { formatToolResult } from './model-text.ts';
export type { ToolRegistry } from './registry.ts';
export { createToolRegistry } from './registry.ts';
export type { McpProtocolVersion, McpRpcResponse } from './remote.ts';
export {
  buildHttpToolTarget,
  executeHttpTool,
  executeMcpTool,
  isUnsupportedMcpProtocolError,
  MCP_PROTOCOL_VERSIONS,
  parseMcpRpcResponse,
  resolveToolAuth,
} from './remote.ts';
export { cloneTurnToolSnapshot, prepareTurnToolSnapshot } from './resolve.ts';
export type * from './types.ts';
