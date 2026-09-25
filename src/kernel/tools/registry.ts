/**
 * Process-local tool registry.
 *
 * Registration is not synchronized — hosts must register tools at startup before
 * concurrent turns or invokeTool calls. Reads during execution are safe under Deno's
 * single-threaded event loop; concurrent mutation of a shared TurnToolSnapshot is
 * avoided by cloneTurnToolSnapshot on invokeTool entry.
 *
 * @module
 */

import type { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import {
  assertFixedEndpointOrigin,
  jsonSchemaFromZod,
  validateToolInputSchema,
  validateToolOutputSchema,
} from './schema.ts';
import type {
  BuiltinWire,
  FunctionToolDef,
  HttpToolDef,
  McpToolDef,
  RegisteredTool,
  ToolDefinitionInput,
} from './types.ts';

const tools = new Map<string, RegisteredTool>();

function schemasFromZod<TIn, TOut>(input: z.ZodType<TIn>, output: z.ZodType<TOut>) {
  const inputSchema = jsonSchemaFromZod(input, 'input');
  validateToolInputSchema(inputSchema);
  const outputSchema = jsonSchemaFromZod(output, 'output');
  validateToolOutputSchema(outputSchema);
  return { inputSchema, outputSchema };
}

function normalizeHttp<TIn = unknown, TOut = unknown>(
  def: Omit<HttpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
    input: z.ZodType<TIn>;
    output: z.ZodType<TOut>;
  },
): HttpToolDef<TIn, TOut> {
  assertFixedEndpointOrigin(def.endpoint);
  return { ...def, type: 'http', ...schemasFromZod(def.input, def.output) };
}

function normalizeMcp<TIn = unknown, TOut = unknown>(
  def: Omit<McpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
    input: z.ZodType<TIn>;
    output: z.ZodType<TOut>;
  },
): McpToolDef<TIn, TOut> {
  return { ...def, type: 'mcp', ...schemasFromZod(def.input, def.output) };
}

function normalizeFunction<TIn = unknown, TOut = unknown>(
  def: Omit<FunctionToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
    input: z.ZodType<TIn>;
    output: z.ZodType<TOut>;
  },
): FunctionToolDef<TIn, TOut> {
  return { ...def, type: 'function', ...schemasFromZod(def.input, def.output) };
}

function normalizeToolDefinition<TIn = unknown, TOut = unknown>(
  def: ToolDefinitionInput<TIn, TOut>,
): RegisteredTool<TIn, TOut> {
  if (def.type === 'builtin') {
    return def;
  }
  if (def.type === 'http') {
    return normalizeHttp(def);
  }
  if (def.type === 'mcp') {
    return normalizeMcp(def);
  }
  return normalizeFunction(def);
}

/** Register or replace a tool definition. */
function registerTool<TIn, TOut>(def: ToolDefinitionInput<TIn, TOut>): RegisteredTool<TIn, TOut> {
  const normalized = normalizeToolDefinition(def);
  tools.set(normalized.name, normalized as RegisteredTool);
  return normalized;
}

/** Register several tools in order. */
function registerTools(defs: ToolDefinitionInput[]): RegisteredTool[] {
  return defs.map((def) => registerTool(def));
}

/** Gets a process-registered tool by name without throwing for an unknown name. */
function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name);
}

/** Gets a process-registered tool or throws when the name is unknown. */
function requireTool(name: string): RegisteredTool {
  const tool = getTool(name);
  if (!tool) {
    throw new TheoremError('config', `Tool '${name}' is not registered`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return tool;
}

/** A registered builtin's wire name on one transport; throws when it has none. */
function requireBuiltinWire(id: string, transport: keyof BuiltinWire): string {
  const tool = getTool(id);
  const wire = tool?.type === 'builtin' ? tool.wire[transport] : undefined;
  if (!wire) {
    throw new TheoremError('config', `Builtin '${id}' has no wire.${transport}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return wire;
}

/** Returns whether a process-registered tool exists under a name. */
function hasTool(name: string): boolean {
  return tools.has(name);
}

/** Lists current process-registered tools in registration order. */
function listTools(): RegisteredTool[] {
  return [...tools.values()];
}

/** Lists names of registered provider builtins. */
function listBuiltinIds(): string[] {
  return listTools()
    .filter((t) => t.type === 'builtin')
    .map((t) => t.name);
}

/** Lists names of registered local function tools. */
function listFunctionIds(): string[] {
  return listTools()
    .filter((t) => t.type === 'function')
    .map((t) => t.name);
}

/** Clears the process-local tool registry; primarily useful for test isolation. */
function resetTools(): void {
  tools.clear();
}

export {
  getTool,
  hasTool,
  listBuiltinIds,
  listFunctionIds,
  listTools,
  registerTool,
  registerTools,
  requireBuiltinWire,
  requireTool,
  resetTools,
};
