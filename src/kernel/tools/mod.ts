/**
 * THEORUM tool registry and execution.
 *
 * @module
 */

export {
  coerceToolResultParts,
  executeRegisteredTool,
  formatToolResult,
  leanToolResultData,
  projectForModel,
} from './execute.ts';
export { registerHarnessTools } from './harness.ts';
export { invokeTool } from './invoke.ts';
export {
  getTool,
  hasTool,
  listBuiltinIds,
  listFunctionIds,
  listTools,
  registerTool,
  registerTools,
  requireTool,
  resetTools,
} from './registry.ts';
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
