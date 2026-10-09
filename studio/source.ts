/**
 * One serializer writes the values, and each tool's schemas as the Zod expressions
 * `zodFromJsonSchema` would build.
 */

import { listsPatterns } from '../src/guardrails/host-patterns.ts';
import type { CompiledStudio } from './compile.ts';
import type { CompiledWorkspace } from './compile-workspace.ts';
import type { ToolRegistration } from './registrations.ts';
import { stubOutputFromSchema } from './stub.ts';
import { keySource, quoteSource } from './tool-schema.ts';

/** Source text written as-is into the module. */
class Expr {
  constructor(readonly code: string) {}
}

/** Arrays of primitives shorter than this stay on one line. */
const INLINE_ARRAY_WIDTH = 60;

/** How a value is laid out: the studio's own files, or a file of the builder's. */
export interface SourceStyle {
  /** One level of indentation. */
  unit: string;
  /** The indentation of the line the value starts on. */
  base: string;
  /** Text of several lines as a template literal, not as lines joined. */
  template: boolean;
  /** Text of one line as source. Default: the studio's, which escapes what could close a script tag. */
  quote?: (text: string) => string;
}

const STUDIO_STYLE: SourceStyle = { unit: '  ', base: '', template: false };

/** `text` as a template literal, each line as it is. */
function templateSource(text: string): string {
  return `\`${text.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')}\``;
}

/** A plain value as source, in `style`. */
export function valueSource(value: unknown, style: SourceStyle): string {
  return literal(value, 0, style);
}

function literal(value: unknown, depth: number, style: SourceStyle = STUDIO_STYLE): string {
  if (value instanceof Expr) return value.code;
  const pad = style.base + style.unit.repeat(depth + 1);
  const close = style.base + style.unit.repeat(depth);
  if (typeof value === 'string') {
    if (!value.includes('\n')) return (style.quote ?? quoteSource)(value);
    if (style.template) return templateSource(value);
    // One line of the text on each line of the source.
    const lines = value.split('\n').map((line) => `${pad}${quoteSource(line)},`);
    return `[\n${lines.join('\n')}\n${close}].join('\\n')`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const items = value.map((item) => literal(item, depth + 1, style));
    const inline = `[${items.join(', ')}]`;
    const primitive = value.every((item) => item === null || typeof item !== 'object');
    if (primitive && inline.length <= INLINE_ARRAY_WIDTH) return inline;
    return `[\n${items.map((item) => `${pad}${item},`).join('\n')}\n${close}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return '{}';
    const lines = entries.map(
      ([key, item]) => `${pad}${keySource(key)}: ${literal(item, depth + 1, style)},`,
    );
    return `{\n${lines.join('\n')}\n${close}}`;
  }
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`Studio source cannot write a ${typeof value} value.`);
}

/** The package an exported module imports the kernel from. */
export const AGENTS_PACKAGE = '@theoremjs/agents';

const COMPILE_IMPORT = `import { compileDetect } from '${AGENTS_PACKAGE}/guardrails/compile';`;

/**
 * The profile's `defineProfile` call. A detector's own patterns need their compiled table, so
 * `detect` is wrapped in `compileDetect`, which compiles them as the host starts; `compiles`
 * says the module needs its import.
 */
function profileSource(profile: CompiledStudio['profile']): {
  code: string;
  compiles: boolean;
} {
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
  // The schema as it is, read by zod: hand-written zod would keep its shape and lose the rest.
  const read = (schema: Record<string, unknown>) =>
    new Expr(`z.fromJSONSchema(${literal(schema, indent + 1)})`);
  const zod = { input: read(inputSchema), output: read(outputSchema) };
  if (fields.type !== 'function') return call({ ...fields, ...zod });
  const { stubResponse, ...functionFields } = fields;
  // The page answers the call, so the tool has no handler; the stub is the studio's stand-in.
  if (functionFields.answeredBy === 'page') return call({ ...functionFields, ...zod });
  const stub = stubResponse ?? stubOutputFromSchema(outputSchema);
  const handler = new Expr(`() => Promise.resolve(${literal(stub, indent + 1)})`);
  return call({ ...functionFields, ...zod, handler });
}

function providerRegistrations(profiles: readonly CompiledStudio['profile'][]) {
  const ids = new Set(
    profiles.flatMap((profile) =>
      profile.type === 'host'
        ? []
        : Object.values(profile.models).map((binding) => binding.provider),
    ),
  );
  const imports = new Set<string>();
  const code: string[] = [];
  for (const id of ids) {
    const factory =
      id === 'google'
        ? 'googleAdapter'
        : id === 'openrouter'
          ? 'openRouterAdapter'
          : id === 'typesafe'
            ? 'typesafeAdapter'
            : id === 'local'
              ? 'openAIChat'
              : undefined;
    if (!factory) continue;
    imports.add('registerProvider');
    imports.add(factory);
    const connection = id === 'local' ? "{ baseURL: 'http://localhost:11434/v1' }" : '{}';
    code.push(
      `registerProvider({ id: ${quoteSource(id)}, connection: ${connection}, adapter: ${factory}() });\n`,
    );
  }
  return { imports: [...imports], code };
}

export function studioSource(compiled: CompiledStudio): string {
  const { profile, customTools, structured } = compiled;
  const providers = providerRegistrations([profile]);
  const imports = [
    'defineProfile',
    'registerProfile',
    ...providers.imports,
    ...(structured ? ['registerStructured'] : []),
    ...(customTools.length ? ['registerTool'] : []),
  ];
  const defined = profileSource(profile);
  const blocks = [
    [
      ...(customTools.length ? [`import { z } from 'zod';`] : []),
      ...(defined.compiles ? [COMPILE_IMPORT] : []),
      `import {\n${[...(compiled.questions ? ['type DecisionQuestion'] : []), ...imports]
        .map((name) => `  ${name},`)
        .join('\n')}\n} from '@theoremjs/agents';\n`,
    ].join('\n'),
    ...providers.code,
    ...customTools.map((tool) => toolSource(tool)),
    ...(structured
      ? [`registerStructured(${quoteSource(structured.id)}, ${literal(structured.spec, 0)});\n`]
      : []),
    `const profile = ${defined.code};\n\nregisterProfile(profile);\n`,
    ...(compiled.questions
      ? [
          `/** What every decision asks about the state, by id. */\nconst questions = ${literal(
            compiled.questions,
            0,
          )} satisfies Record<string, DecisionQuestion>;\n`,
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
export function agentIdentifier(agentId: string, taken: Set<string>): string {
  const words = agentId.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words
    .map((word, index) => (index ? word[0].toUpperCase() + word.slice(1) : word.toLowerCase()))
    .join('');
  const base = /^[A-Za-z_$]/.test(joined) ? joined : `agent${joined}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

/**
 * An agent's module: its profile, and its structured reply and questions when it has them.
 * Registers nothing. `from` is where the module imports the kernel from.
 */
export function agentModule(compiled: CompiledStudio, from = AGENTS_PACKAGE): string {
  const { profile, structured, questions } = compiled;
  const imports = [...(questions ? ['type DecisionQuestion'] : []), 'defineProfile'];
  const defined = profileSource(profile);
  const blocks = [
    `import { ${imports.join(', ')} } from ${quoteSource(from)};\n${
      defined.compiles ? `${COMPILE_IMPORT}\n` : ''
    }`,
    ...(structured
      ? [
          `/** The reply's shape, registered before the profile. */\nexport const structured = ${literal(
            structured,
            0,
          )};\n`,
        ]
      : []),
    `export const profile = ${defined.code};\n`,
    ...(questions
      ? [
          `/** What every decision asks about the state, by id. */\nexport const questions = ${literal(
            questions,
            0,
          )} satisfies Record<string, DecisionQuestion>;\n`,
        ]
      : []),
  ];
  return blocks.join('\n');
}

/**
 * One tool's module: a function that registers it, for the setup to call where the tool belongs
 * in its order. `from` is where the module imports the kernel and `z` from.
 */
export function toolModule(
  tool: ToolRegistration,
  register: string,
  from: { agents: string; zod: string },
): string {
  const zod = tool.type === 'agent' ? undefined : from.zod;
  const imports = zod === from.agents
    ? `import { registerTool, z } from ${quoteSource(from.agents)};\n`
    : `${zod ? `import { z } from ${quoteSource(zod)};\n` : ''}import { registerTool } from ${
      quoteSource(from.agents)
    };\n`;
  const order = tool.type === 'agent'
    ? 'Call it after the agent it runs is registered, and before any agent that allows it.'
    : 'Call it before any agent that allows it is registered.';
  // A function tool made in the studio answers with its sample until its handler is written.
  const stands = tool.type === 'function' && tool.answeredBy !== 'page';
  const note = stands ? `${order}\n * Its handler returns the studio's sample answer: write the real one here.` : order;
  return [
    imports,
    `/**${stands ? '\n *' : ''} Registers \`${tool.name}\`. ${note}${stands ? '\n' : ''} */\nexport function ${register}(): void {\n${
      toolSource(tool, 1)
    }}\n`,
  ].join('\n');
}

/** The library's function, HTTP and MCP tools, each once; agent tools wait for their agents. */
function libraryModule(tools: readonly ToolRegistration[]): string {
  return [
    `import { z } from 'zod';\nimport { registerTool } from '@theoremjs/agents';\n`,
    `/** Registers the tools the agents share. \`theorem.ts\` calls it before any agent. */\nexport function registerToolLibrary(): void {\n${tools
      .map((tool) => toolSource(tool, 1))
      .join('\n')}}\n`,
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
  const taken = new Set([
    'registerProfile',
    'registerStructured',
    'registerTool',
    'registerToolLibrary',
  ]);
  const agents = compiled.agents.map((agent) => ({
    agent,
    path: agentModulePath(agent.agentId),
    name: agentIdentifier(agent.agentId, taken),
  }));
  const structured = agents.some(({ agent }) => agent.structured);
  const agentTools = agents.some(({ agent }) =>
    agent.customTools.some((tool) => tool.type === 'agent'),
  );
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
  const providers = providerRegistrations(agents.map(({ agent }) => agent.profile));
  const theorem = [
    [
      '/**',
      ' * Registers every agent and tool, server side. Import it once, before any',
      ' * route that runs an agent. Each agent comes after the agents it names, and',
      ' * each agent tool after the agent it runs.',
      ' */',
      `import {\n${[
        'registerProfile',
        ...providers.imports,
        ...(structured ? ['registerStructured'] : []),
        ...(agentTools ? ['registerTool'] : []),
      ]
        .map((each) => `  ${each},`)
        .join('\n')}\n} from '@theoremjs/agents';`,
      ...(library.size ? [`import { registerToolLibrary } from './tools';`] : []),
      ...agents.map(({ path, name }) => `import * as ${name} from '${importSpecifier(path)}';`),
      '',
    ].join('\n'),
    ...providers.code,
    ...(library.size ? ['registerToolLibrary();\n'] : []),
    ...steps,
  ];
  return [
    ...(library.size ? [{ path: 'tools.ts', code: libraryModule([...library.values()]) }] : []),
    ...agents.map(({ agent, path }) => ({ path, code: agentModule(agent) })),
    { path: 'theorem.ts', code: theorem.join('\n') },
  ];
}
