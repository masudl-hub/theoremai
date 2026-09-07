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
import { TheorumError } from '../../guardrails/error.ts';
import { jsonSchemaFromZod, validateToolInputSchema, validateToolOutputSchema } from './schema.ts';
import type {
  FunctionToolDef,
  HttpToolDef,
  McpToolDef,
  RegisteredTool,
  ToolDefinitionInput,
} from './types.ts';

const tools = new Map<string, RegisteredTool>();

function normalizeHttp<TIn = unknown, TOut = unknown>(
  def: Omit<HttpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
    input: z.ZodType<TIn>;
    output: z.ZodType<TOut>;
  },
): HttpToolDef<TIn, TOut> {
  const inputSchema = jsonSchemaFromZod(def.input, 'input');
  validateToolInputSchema(inputSchema);
  const outputSchema = jsonSchemaFromZod(def.output, 'output');
  validateToolOutputSchema(outputSchema);
  return {
    ...def,
    type: 'http',
    inputSchema,
    outputSchema,
  };
}

function normalizeMcp<TIn = unknown, TOut = unknown>(
  def: Omit<McpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
    input: z.ZodType<TIn>;
    output: z.ZodType<TOut>;
  },
): McpToolDef<TIn, TOut> {
  const inputSchema = jsonSchemaFromZod(def.input, 'input');
  validateToolInputSchema(inputSchema);
  const outputSchema = jsonSchemaFromZod(def.output, 'output');
  validateToolOutputSchema(outputSchema);
  return {
    ...def,
    type: 'mcp',
    inputSchema,
    outputSchema,
  };
}

function normalizeFunction<TIn = unknown, TOut = unknown>(
  def: Omit<FunctionToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
    input: z.ZodType<TIn>;
    output: z.ZodType<TOut>;
  },
): FunctionToolDef<TIn, TOut> {
  const inputSchema = jsonSchemaFromZod(def.input, 'input');
  validateToolInputSchema(inputSchema);
  const outputSchema = jsonSchemaFromZod(def.output, 'output');
  validateToolOutputSchema(outputSchema);
  return {
    ...def,
    type: 'function',
    inputSchema,
    outputSchema,
  };
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

function getTool(name: string): RegisteredTool | undefined {
  return tools.get(name);
}

function requireTool(name: string): RegisteredTool {
  const tool = getTool(name);
  if (!tool) {
    throw new TheorumError(`Tool '${name}' is not registered`);
  }
  return tool;
}

function hasTool(name: string): boolean {
  return tools.has(name);
}

function listTools(): RegisteredTool[] {
  return [...tools.values()];
}

function listBuiltinIds(): string[] {
  return listTools()
    .filter((t) => t.type === 'builtin')
    .map((t) => t.name);
}

function listFunctionIds(): string[] {
  return listTools()
    .filter((t) => t.type === 'function')
    .map((t) => t.name);
}

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
  requireTool,
  resetTools,
};
