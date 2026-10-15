/**
 * One serializer writes the values, and each tool's schemas as the Zod expressions
 * `zodFromJsonSchema` would build.
 */

import { listsPatterns } from '@theoremjs/agents/guardrails';
import type { CompiledStudio } from './compile.ts';
import type { CompiledWorkspace } from './compile-workspace.ts';
import { withoutStudioFills } from './policy.ts';
import { adapterFactory, kernelAdapters, type StudioProvider } from './providers.ts';
import type { ToolRegistration } from './registrations.ts';
import type { ProjectOrigins, ProviderPlace } from './server/save-wire.ts';
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
function profileSource(profile: PrintedProfile): {
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

/** A profile as it is printed: its own settings, with code standing where the studio holds none. */
type PrintedProfile = CompiledStudio['profile'] | (Record<string, unknown> & Pick<CompiledStudio['profile'], 'guardrails'>);

/**
 * What a project's files hold that an export names where it stands, since the studio does not
 * hold it: each provider's definition, and the settings its profiles set in code.
 */
export interface ProjectCode {
  /** Where the files define each provider that is still as they define it. */
  providers: readonly ProviderPlace[];
  /** The settings set in code, by profile id. */
  origins: ProjectOrigins['profiles'];
}

/**
 * The profile with the check of each list's item rule as the project's files write it. A check is
 * code, so the studio holds none: a rule the files do not place gets a line that says what is owed.
 */
function withItemChecks(profile: CompiledStudio['profile'], checks: ProjectOrigins['profiles']): PrintedProfile {
  if (!('outputs' in profile)) return profile;
  const validation = profile.outputs?.validation;
  if (!validation?.items) return profile;
  const origins = checks[profile.id] ?? [];
  const items = Object.fromEntries(
    Object.entries(validation.items).map(([list, rule]) => {
      const path = ['outputs', 'validation', 'items', list, 'check'];
      const at = origins.find(
        (origin) => origin.kind === 'code' && origin.text !== undefined && origin.path.join('\n') === path.join('\n'),
      );
      const check = at?.text !== undefined
        ? `${at.text} /* ${String(at.file)}:${String(at.line)} */`
        : `undefined /* The check of each item of ${quoteSource(list)} is your own code: name it here. */`;
      return [list, { check: new Expr(check), onFail: rule.onFail }];
    }),
  );
  return { ...profile, outputs: { ...profile.outputs, validation: { ...validation, items } } };
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

/** What `defineProvider` and `registerProvider` take for `provider`, with the adapter `factory` makes. */
function providerOptions(provider: StudioProvider, factory: string): string {
  const held = Object.entries(provider.connection ?? {}).map(
    ([key, value]) => `${keySource(key)}: ${quoteSource(value)}`,
  );
  const connection = held.length ? `{ ${held.join(', ')} }` : '{}';
  const slots = (['keySlot', 'fallbackKeySlot'] as const).flatMap((slot) =>
    provider[slot] === undefined ? [] : [`  ${slot}: ${quoteSource(provider[slot])},\n`]
  );
  // An adapter the provider tells what its models support is called with it.
  const told = provider.capabilities ? literal({ capabilities: provider.capabilities }, 1) : '';
  return `{\n  id: ${quoteSource(provider.id)},\n  connection: ${connection},\n${slots.join('')}  adapter: ${factory}(${told}),\n}`;
}

/**
 * A provider's module: its definition under `name`, for the setup to register. `from` is where the
 * module imports the kernel from. None for an adapter that is the project's own.
 */
export function providerModule(provider: StudioProvider, name: string, from = AGENTS_PACKAGE): string | undefined {
  const factory = adapterFactory(provider.adapter);
  if (!factory) return undefined;
  return [
    `import { defineProvider, ${factory} } from ${quoteSource(from)};\n`,
    `export const ${name} = defineProvider(${providerOptions(provider, factory)});\n`,
  ].join('\n');
}

/** A provider as the code view shows it: its definition, or why the studio writes none. */
export function providerSource(provider: StudioProvider): string {
  return providerModule(provider, agentIdentifier(provider.id, new Set(), 'provider')) ??
    `// The provider ${quoteSource(provider.id)} is defined on your own adapter ${quoteSource(provider.adapter)}, so its definition stays in your code.\n`;
}

/**
 * The registration of each provider a model of `profiles` names. One the project's files define
 * (`places`) is imported under its own name, by its path from the project's folder, or named by
 * its line when the files do not export it. One whose adapter is the project's own is not the
 * studio's to write: the code says so where its registration belongs.
 */
function providerRegistrations(
  profiles: readonly CompiledStudio['profile'][],
  providers: readonly StudioProvider[],
  places: readonly ProviderPlace[] = [],
) {
  const ids = new Set(
    profiles.flatMap((profile) =>
      profile.type === 'host'
        ? []
        : Object.values(profile.models).map((binding) => binding.provider),
    ),
  );
  const imports = new Set<string>();
  const own = new Map<string, string[]>();
  const code: string[] = [];
  for (const id of ids) {
    const place = places.find((held) => held.id === id);
    if (place?.name !== undefined && place.exported) {
      imports.add('registerProvider');
      const from = importSpecifier(place.file);
      own.set(from, [...(own.get(from) ?? []), place.name]);
      code.push(`registerProvider(${place.name});\n`);
      continue;
    }
    if (place) {
      code.push(
        `// Register the provider ${quoteSource(id)} here, before the agents: ${place.file}:${String(place.line)} defines it and does not export it.\n`,
      );
      continue;
    }
    const provider = providers.find((held) => held.id === id);
    const factory = provider && adapterFactory(provider.adapter);
    if (!provider || !factory) {
      code.push(
        `// Register the provider ${quoteSource(id)} here, before the agents: its adapter is the project's own.\n`,
      );
      continue;
    }
    imports.add('registerProvider');
    imports.add(factory);
    code.push(`registerProvider(${providerOptions(provider, factory)});\n`);
  }
  return {
    imports: [...imports],
    own: [...own].map(([from, names]) => `import { ${names.join(', ')} } from ${quoteSource(from)};`),
    code,
  };
}

export function studioSource(compiled: CompiledStudio): string {
  const { profile, customTools, structured } = compiled;
  const providers = providerRegistrations([profile], compiled.providers);
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

/**
 * What no identifier the studio writes may be: a word JavaScript keeps for itself, and a name the
 * modules it writes import beside one, which the identifier would hide.
 */
const UNNAMEABLE = new Set([
  ...'arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof undefined var void while with yield'
    .split(' '),
  ...'compileDetect DecisionQuestion defineProfile defineProvider registerProfile registerProvider registerProviders registerStructured registerTool registerToolLibrary z'
    .split(' '),
  ...kernelAdapters().flatMap((adapter) => adapterFactory(adapter) ?? []),
]);

/** A camelCase identifier for an id, unique among `taken`; `kind` leads one that starts with a digit. */
export function agentIdentifier(agentId: string, taken: Set<string>, kind = 'agent'): string {
  const words = agentId.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words
    .map((word, index) => (index ? word[0].toUpperCase() + word.slice(1) : word.toLowerCase()))
    .join('');
  const base = /^[A-Za-z_$]/.test(joined) ? joined : `${kind}${joined}`;
  let name = base;
  for (let n = 2; taken.has(name) || UNNAMEABLE.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

/**
 * An agent's module: its profile, and its structured reply and questions when it has them.
 * Registers nothing. `from` is where the module imports the kernel from. With `checks` (the
 * settings set in code, by profile id), each item rule is written with its check.
 */
export function agentModule(
  compiled: CompiledStudio,
  from = AGENTS_PACKAGE,
  checks?: ProjectOrigins['profiles'],
): string {
  const { profile, structured, questions } = compiled;
  const imports = [...(questions ? ['type DecisionQuestion'] : []), 'defineProfile'];
  const defined = profileSource(withoutStudioFills(checks ? withItemChecks(profile, checks) : profile));
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
export function workspaceSource(compiled: CompiledWorkspace, project?: ProjectCode): SourceFile[] {
  const library = new Map<string, ToolRegistration>();
  for (const tool of compiled.agents.flatMap((agent) => agent.customTools)) {
    if (tool.type !== 'agent' && !library.has(tool.name)) library.set(tool.name, tool);
  }
  const taken = new Set([
    'registerProfile',
    'registerStructured',
    'registerTool',
    'registerToolLibrary',
    ...(project?.providers ?? []).flatMap((place) => (place.name === undefined ? [] : [place.name])),
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
  const providers = providerRegistrations(
    agents.map(({ agent }) => agent.profile),
    agents[0]?.agent.providers ?? [],
    project?.providers,
  );
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
      ...(providers.own.length
        ? ["// The project's own providers, each by its path from the project's folder.", ...providers.own]
        : []),
      '',
    ].join('\n'),
    ...providers.code,
    ...(library.size ? ['registerToolLibrary();\n'] : []),
    ...steps,
  ];
  return [
    ...(library.size ? [{ path: 'tools.ts', code: libraryModule([...library.values()]) }] : []),
    ...agents.map(({ agent, path }) => ({
      path,
      code: agentModule(agent, AGENTS_PACKAGE, project?.origins ?? {}),
    })),
    { path: 'theorem.ts', code: theorem.join('\n') },
  ];
}
