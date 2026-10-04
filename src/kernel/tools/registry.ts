import type { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { activityLabelProblem } from './activity-label.ts';
import { createMcpSessionCache, type McpSessionCache } from './mcp-sessions.ts';
import {
  assertFixedEndpointOrigin,
  jsonSchemaFromZod,
  validateToolInputSchema,
  validateToolOutputSchema,
} from './schema.ts';
import type {
  FunctionToolDef,
  HttpToolDef,
  McpToolDef,
  RegisteredTool,
  ToolAuthConfig,
  ToolDefinitionInput,
  ToolLabels,
} from './types.ts';

function schemasFromZod<TIn, TOut>(def: {
  name: string;
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  labels?: ToolLabels;
}) {
  const inputSchema = jsonSchemaFromZod(def.input, 'input');
  validateToolInputSchema(inputSchema);
  const outputSchema = jsonSchemaFromZod(def.output, 'output');
  validateToolOutputSchema(outputSchema);
  const labels = {
    activity: { input: inputSchema },
    activityPast: { input: inputSchema, output: outputSchema },
    request: { input: inputSchema },
  };
  for (const field of ['activity', 'activityPast', 'request'] as const) {
    const template = def.labels?.[field];
    const problem = template ? activityLabelProblem(template, labels[field]) : undefined;
    if (problem) {
      throw new TheoremError(
        'config',
        `Tool "${def.name}" ${field} label: ${problem}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
  return { inputSchema, outputSchema };
}

/** The person is told which service they sign in to; the tool's builder names it, never the model or the server. */
function assertAuthService(name: string, auth: ToolAuthConfig | undefined): void {
  if (auth && (typeof auth.service !== 'string' || !auth.service.trim())) {
    throw new TheoremError(
      'config',
      `Tool "${name}" signs in with slot "${auth.slot}" but names no service`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function normalizeHttp<TIn = unknown, TOut = unknown>(
  def: Omit<HttpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
    input: z.ZodType<TIn>;
    output: z.ZodType<TOut>;
  },
): HttpToolDef<TIn, TOut> {
  assertFixedEndpointOrigin(def.endpoint);
  assertAuthService(def.name, def.auth);
  return { ...def, type: 'http', ...schemasFromZod(def) };
}

function normalizeMcp<TIn = unknown, TOut = unknown>(
  def: Omit<McpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
    input: z.ZodType<TIn>;
    output: z.ZodType<TOut>;
  },
): McpToolDef<TIn, TOut> {
  assertAuthService(def.name, def.auth);
  return { ...def, type: 'mcp', ...schemasFromZod(def) };
}

function normalizeFunction<TIn = unknown, TOut = unknown>(
  def: Omit<FunctionToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
    input: z.ZodType<TIn>;
    output: z.ZodType<TOut>;
  },
): FunctionToolDef<TIn, TOut> {
  assertAuthService(def.name, def.auth);
  return { ...def, type: 'function', ...schemasFromZod(def) };
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

interface ToolRegistry {
  /** Replaces a tool of the same name. */
  register<TIn, TOut>(def: ToolDefinitionInput<TIn, TOut>): RegisteredTool<TIn, TOut>;
  registerMany(defs: ToolDefinitionInput[]): RegisteredTool[];
  get(name: string): RegisteredTool | undefined;
  /** Throws when there is none. */
  require(name: string): RegisteredTool;
  has(name: string): boolean;
  list(): RegisteredTool[];
  /** Also forgets the MCP sessions. */
  reset(): void;
  /** Sessions for this scope's MCP servers that require one; never shared across scopes. */
  readonly mcpSessions: McpSessionCache;
}

/** Registration is not synchronized: register a scope's tools before its turns or invokes run. */
function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();
  const mcpSessions = createMcpSessionCache();
  const get = (name: string) => tools.get(name);
  const register = <TIn, TOut>(def: ToolDefinitionInput<TIn, TOut>) => {
    const normalized = normalizeToolDefinition(def);
    tools.set(normalized.name, normalized as RegisteredTool);
    return normalized;
  };
  return {
    register,
    registerMany: (defs) => defs.map((def) => register(def)),
    get,
    require(name) {
      const tool = get(name);
      if (!tool) {
        throw new TheoremError('config', `Tool '${name}' is not registered`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      }
      return tool;
    },
    has: (name) => tools.has(name),
    list: () => [...tools.values()],
    reset: () => {
      tools.clear();
      mcpSessions.clear();
    },
    mcpSessions,
  };
}

export type { ToolRegistry };
export { createToolRegistry };
