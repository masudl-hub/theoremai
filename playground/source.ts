/**
 * One serializer writes the values, and each tool's schemas as the Zod expressions
 * `zodFromJsonSchema` would build.
 */

import { listsPatterns } from '../src/guardrails/host-patterns.ts';
import type { CompiledPlayground } from './compile.ts';
import type { CompiledWorkspace } from './compile-workspace.ts';
import type { ToolRegistration } from './registrations.ts';
import { stubOutputFromSchema } from './stub.ts';
import { keySource, quoteSource, zodExprFromJsonSchema } from './tool-schema.ts';

/** Source text written as-is into the module. */
class Expr {
  constructor(readonly code: string) {}
}

/** Arrays of primitives shorter than this stay on one line. */
const INLINE_ARRAY_WIDTH = 60;

function literal(value: unknown, depth: number): string {
  if (value instanceof Expr) return value.code;
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  if (typeof value === 'string') {
    if (!value.includes('\n')) return quoteSource(value);
    // One line of the text on each line of the source.
    const lines = value.split('\n').map((line) => `${pad}${quoteSource(line)},`);
    return `[\n${lines.join('\n')}\n${close}].join('\\n')`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const items = value.map((item) => literal(item, depth + 1));
    const inline = `[${items.join(', ')}]`;
    const primitive = value.every((item) => item === null || typeof item !== 'object');
    if (primitive && inline.length <= INLINE_ARRAY_WIDTH) return inline;
    return `[\n${items.map((item) => `${pad}${item},`).join('\n')}\n${close}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return '{}';
    const lines = entries.map(([key, item]) =>
      `${pad}${keySource(key)}: ${literal(item, depth + 1)},`
    );
    return `{\n${lines.join('\n')}\n${close}}`;
  }
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`Playground source cannot write a ${typeof value} value.`);
}

const COMPILE_IMPORT = `import { compileDetect } from '@theoremjs/agents/guardrails/compile';`;

/**
 * The profile's `defineProfile` call. A detector's own patterns need their compiled table, so
 * `detect` is wrapped in `compileDetect`, which compiles them as the host starts; `compiles`
 * says the module needs its import.
 */
function profileSource(profile: CompiledPlayground['profile']): { code: string; compiles: boolean } {
  const { guardrails } = profile;
  const detect = guardrails && 'detect' in guardrails ? guardrails.detect : undefined;
  if (typeof detect !== 'object' || !listsPatterns(detect)) {
    return { code: `defineProfile(${literal(profile, 0)})`, compiles: false };
  }
  const compiled = new Expr(`compileDetect(${literal(detect, 2)})`);
  const written = { ...profile, guardrails: { ...guardrails, detect: compiled } };
  return { code: `defineProfile(${literal(written, 0)})`, compiles: true };
}

/** A tool's registration, as a call; `indent` places it in a function body. */
function toolSource(tool: ToolRegistration, indent = 0): string {
  const call = (fields: Record<string, unknown>) => {
    const pad = '  '.repeat(indent);
    return `${pad}registerTool(${literal(fields, indent)});\n`;
  };
  const { inputSchema, outputSchema, ...fields } = tool;
  // The kernel fixes an agent tool's schemas.
  if (fields.type === 'agent') return call(fields);
  const zod = {
    input: new Expr(zodExprFromJsonSchema(inputSchema, indent + 1)),
    output: new Expr(zodExprFromJsonSchema(outputSchema, indent + 1)),
  };
  if (fields.type !== 'function') return call({ ...fields, ...zod });
  const { stubResponse, ...functionFields } = fields;
  // The page answers the call, so the tool has no handler; the stub is the playground's stand-in.
  if (functionFields.answeredBy === 'page') return call({ ...functionFields, ...zod });
  const stub = stubResponse ?? stubOutputFromSchema(outputSchema);
  const handler = new Expr(`() => Promise.resolve(${literal(stub, indent + 1)})`);
  return call({ ...functionFields, ...zod, handler });
}

export function playgroundSource(compiled: CompiledPlayground): string {
  const { profile, customTools, structured } = compiled;
  const imports = [
    'defineProfile',
    'registerProfile',
    ...(structured ? ['registerStructured'] : []),
    ...(customTools.length ? ['registerTool'] : []),
  ];
  const defined = profileSource(profile);
  const blocks = [
    [
      ...(customTools.length ? [`import { z } from 'zod';`] : []),
      ...(defined.compiles ? [COMPILE_IMPORT] : []),
      `import {\n${
        [...(compiled.questions ? ['type DecisionQuestion'] : []), ...imports]
          .map((name) => `  ${name},`).join('\n')
      }\n} from '@theoremjs/agents';\n`,
    ].join('\n'),
    ...customTools.map((tool) => toolSource(tool)),
    ...(structured
      ? [`registerStructured(${quoteSource(structured.id)}, ${literal(structured.spec, 0)});\n`]
      : []),
    `const profile = ${defined.code};\n\nregisterProfile(profile);\n`,
    ...(compiled.questions
      ? [
        `/** What every decision asks about the state, by id. */\nconst questions = ${
          literal(compiled.questions, 0)
        } satisfies Record<string, DecisionQuestion>;\n`,
      ]
      : []),
  ];
  return blocks.join('\n');
}

/** A file of an exported workspace: its path from the folder it lands in, and its text. */
export interface SourceFile {
  path: string;
  code: string;
}

/** Where an agent's module lands, and how `theorem.ts` imports it. */
export function agentModulePath(agentId: string): string {
  return `agents/${agentId}.ts`;
}

/** The import specifier for a module path: relative, without its extension. */
export function importSpecifier(path: string): string {
  return `./${path.replace(/\.tsx?$/, '')}`;
}

/** A camelCase identifier for an agent id, unique among `taken`. */
function agentIdentifier(agentId: string, taken: Set<string>): string {
  const words = agentId.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((word, index) =>
    index ? word[0].toUpperCase() + word.slice(1) : word.toLowerCase()
  ).join('');
  const base = /^[A-Za-z_$]/.test(joined) ? joined : `agent${joined}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

/** An agent's module: its profile, and its structured reply and questions when it has them. Registers nothing. */
function agentModule(compiled: CompiledPlayground): string {
  const { profile, structured, questions } = compiled;
  const imports = [...(questions ? ['type DecisionQuestion'] : []), 'defineProfile'];
  const defined = profileSource(profile);
  const blocks = [
    `import { ${imports.join(', ')} } from '@theoremjs/agents';\n${
      defined.compiles ? `${COMPILE_IMPORT}\n` : ''
    }`,
    ...(structured
      ? [
        `/** The reply's shape: \`theorem.ts\` registers it before the profile. */\nexport const structured = ${
          literal(structured, 0)
        };\n`,
      ]
      : []),
    `export const profile = ${defined.code};\n`,
    ...(questions
      ? [
        `/** What every decision asks about the state, by id. */\nexport const questions = ${
          literal(questions, 0)
        } satisfies Record<string, DecisionQuestion>;\n`,
      ]
      : []),
  ];
  return blocks.join('\n');
}

/** The library's function, HTTP and MCP tools, each once; agent tools wait for their agents. */
function libraryModule(tools: readonly ToolRegistration[]): string {
  return [
    `import { z } from 'zod';\nimport { registerTool } from '@theoremjs/agents';\n`,
    `/** Registers the tools the agents share. \`theorem.ts\` calls it before any agent. */\nexport function registerToolLibrary(): void {\n${
      tools.map((tool) => toolSource(tool, 1)).join('\n')
    }}\n`,
  ].join('\n');
}

/**
 * A workspace as source: `tools.ts` with the shared tools, one `agents/<id>.ts`
 * per agent, and `theorem.ts`, which registers them all. Each agent is registered
 * after the agents it names, and each agent tool after the agent it runs, so the
 * order is the one a scope needs and reads in one place.
 */
export function workspaceSource(compiled: CompiledWorkspace): SourceFile[] {
  const library = new Map<string, ToolRegistration>();
  for (const tool of compiled.agents.flatMap((agent) => agent.customTools)) {
    if (tool.type !== 'agent' && !library.has(tool.name)) library.set(tool.name, tool);
  }
  const taken = new Set(['registerProfile', 'registerStructured', 'registerTool', 'registerToolLibrary']);
  const agents = compiled.agents.map((agent) => ({
    agent,
    path: agentModulePath(agent.agentId),
    name: agentIdentifier(agent.agentId, taken),
  }));
  const structured = agents.some(({ agent }) => agent.structured);
  const agentTools = agents.some(({ agent }) => agent.customTools.some((tool) => tool.type === 'agent'));
  const registered = new Set<string>();
  const steps = agents.map(({ agent, name }) => {
    const lines: string[] = [];
    for (const tool of agent.customTools) {
      if (tool.type !== 'agent' || registered.has(tool.name)) continue;
      registered.add(tool.name);
      lines.push(toolSource(tool));
    }
    if (agent.structured) {
      lines.push(`registerStructured(${name}.structured.id, ${name}.structured.spec);\n`);
    }
    lines.push(`registerProfile(${name}.profile);\n`);
    return lines.join('\n');
  });
  const theorem = [
    [
      '/**',
      ' * Registers every agent and tool, server side. Import it once, before any',
      ' * route that runs an agent. Each agent comes after the agents it names, and',
      ' * each agent tool after the agent it runs.',
      ' */',
      `import {\n${
        [
          'registerProfile',
          ...(structured ? ['registerStructured'] : []),
          ...(agentTools ? ['registerTool'] : []),
        ].map((each) => `  ${each},`).join('\n')
      }\n} from '@theoremjs/agents';`,
      ...(library.size ? [`import { registerToolLibrary } from './tools';`] : []),
      ...agents.map(({ path, name }) => `import * as ${name} from '${importSpecifier(path)}';`),
      '',
    ].join('\n'),
    ...(library.size ? ['registerToolLibrary();\n'] : []),
    ...steps,
  ];
  return [
    ...(library.size ? [{ path: 'tools.ts', code: libraryModule([...library.values()]) }] : []),
    ...agents.map(({ agent, path }) => ({ path, code: agentModule(agent) })),
    { path: 'theorem.ts', code: theorem.join('\n') },
  ];
}
