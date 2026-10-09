/**
 * What Save writes for a profile or tool the builder added in the studio: a
 * new file beside the project's others, and the lines in the setup that import
 * and register it. A scope checks a profile against the tools registered
 * before it, and an agent tool against the profile it runs, so each line goes
 * where that order holds.
 *
 * @module
 */

import ts from 'typescript';
import { dirname, relative, resolve } from 'node:path';
import type { CompiledStudio } from '../compile.ts';
import type { ToolRegistration } from '../registrations.ts';
import { AGENTS_PACKAGE, agentIdentifier, agentModule, toolModule } from '../source.ts';
import { calleeName, importOf, isInside, namedValue, type ProjectSource, unwrapped } from './project-source.ts';
import { indentAt, indentUnit, type SavePlan, type SourceEdit } from './save-plan.ts';
import type { SaveChange } from './save-wire.ts';

/** A profile or tool the studio added, as it compiles. `agents` is every agent of the workspace, in the order a scope registers them. */
export interface NewSubjects {
  agents: readonly CompiledStudio[];
  /** The ids of the agents that are new. */
  profiles: readonly string[];
  /** The tools that are new, each once. */
  tools: readonly ToolRegistration[];
}

/** A file name is the id or name itself, so it holds only what every file system takes. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A statement of the setup that registers something, and what it calls. */
interface Registration {
  statement: ts.ExpressionStatement;
  call: ts.CallExpression;
  name: string;
}

function registrations(source: ts.SourceFile): Registration[] {
  const found: Registration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isExpressionStatement(node)) {
      const held = ts.isAwaitExpression(node.expression) ? node.expression.expression : node.expression;
      const call = unwrapped(held);
      const name = ts.isCallExpression(call) ? calleeName(call) : undefined;
      if (ts.isCallExpression(call) && (name === 'registerProfile' || name === 'registerTool')) {
        found.push({ statement: node, call, name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The file whose statements register the project's profiles: the setup, or the first file it reads that does. */
function registeringFile(project: ProjectSource): ts.SourceFile | undefined {
  const files = [...project.files.values()];
  return files.find((source) => registrations(source).some(({ name }) => name === 'registerProfile')) ??
    files.find((source) => registrations(source).length > 0) ?? project.files.get(project.entry);
}

/** The id of the profile a `registerProfile` statement registers, when its files write it out. */
function registeredId(project: ProjectSource, source: ts.SourceFile, call: ts.CallExpression): string | undefined {
  const [argument] = call.arguments;
  if (!argument) return undefined;
  const { origin } = namedValue(project, { node: argument, source });
  const defined = unwrapped(origin.node);
  const options = ts.isCallExpression(defined) && defined.arguments[0] ? unwrapped(defined.arguments[0]) : defined;
  for (const [id, targets] of project.profiles) {
    if (targets.some((target) => target.options === options)) return id;
  }
  return undefined;
}

/** Where a file imports one of `names` from, the first of the project's files that does. */
function importedFrom(project: ProjectSource, names: readonly string[]): { specifier: string; file: string } | undefined {
  for (const [file, source] of project.files) {
    for (const name of names) {
      const found = importOf(source, name);
      if (found?.name === name) return { specifier: found.specifier, file };
    }
  }
  return undefined;
}

/** The extension the project's relative imports end in: `.ts`, `.js`, or none. */
function importExtension(project: ProjectSource, agents: string): string {
  const relatives = [...project.files.values()].flatMap((source) =>
    source.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith('.')
        ? [statement.moduleSpecifier.text]
        : []
    )
  );
  const model = relatives[0] ?? agents;
  return /\.[cm]?[jt]sx?$/.exec(model)?.[0].replace('tsx', 'ts') ?? '';
}

/** How `from` imports `to`: a relative path, ending as the project's imports do. */
function specifierTo(from: string, to: string, extension: string): string {
  const path = relative(dirname(from), to).replace(/\.ts$/, extension);
  return path.startsWith('.') ? path : `./${path}`;
}

/** A specifier written in `file`, as `to` must write it: a relative one is turned to start from there. */
function carried(specifier: string, file: string, to: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const path = relative(dirname(to), resolve(dirname(file), specifier));
  return path.startsWith('.') ? path : `./${path}`;
}

/** The folder most of `files` are in, or `fallback` when there are none. */
function commonFolder(files: readonly string[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(dirname(file), (counts.get(dirname(file)) ?? 0) + 1);
  let best = fallback;
  let most = 0;
  for (const [folder, count] of counts) {
    if (count > most) [best, most] = [folder, count];
  }
  return best;
}

/** `registerLogWatering` for `log_watering`, unique among `taken`. */
function registerName(tool: string, taken: Set<string>): string {
  const words = tool.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const base = `register${words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

/** Every name a file already uses, so a new one does not shadow it. */
function namesIn(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** The places in the setup a new line can go, each as the position and the text around the line. */
class Setup {
  private readonly edits: SourceEdit[] = [];
  private readonly found: Registration[];
  private readonly file: string;
  private readonly imported = new Set<string>();
  /** The lines that go after everything the setup registers, in order. */
  private readonly tail: string[] = [];

  constructor(private readonly project: ProjectSource, private readonly source: ts.SourceFile) {
    this.found = registrations(source);
    this.file = source.fileName;
  }

  /** Whether each registration is a statement of the file or of a function, where a line beside it runs once. */
  get plain(): boolean {
    return this.found.every(({ statement: { parent } }) =>
      ts.isSourceFile(parent) || (ts.isBlock(parent) && ts.isFunctionLike(parent.parent))
    );
  }

  private insert(position: number, text: string) {
    this.edits.push({ file: this.file, start: position, end: position, text });
  }

  /** The statement that registers `profile`, when the files show which one does. */
  registers(profile: string): ts.ExpressionStatement | undefined {
    return this.found.find(({ name, call }) =>
      name === 'registerProfile' && registeredId(this.project, this.source, call) === profile
    )?.statement;
  }

  after(statement: ts.Node, lines: readonly string[]) {
    const indent = indentAt(this.source, statement.getStart(this.source));
    this.insert(statement.end, lines.map((line) => `\n${indent}${line}`).join(''));
  }

  before(statement: ts.Node, lines: readonly string[]) {
    const start = statement.getStart(this.source);
    const indent = indentAt(this.source, start);
    this.insert(start, lines.map((line) => `${line}\n${indent}`).join(''));
  }

  /** Imports `name` from the kernel when the file does not yet: in the import that reads it, or a new one. */
  needs(name: string, agents: string) {
    if (this.imported.has(name) || importOf(this.source, name)) return;
    this.imported.add(name);
    for (const statement of this.source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (statement.moduleSpecifier.text !== agents || statement.importClause?.isTypeOnly) continue;
      const last = bindings && ts.isNamedImports(bindings) ? bindings.elements.at(-1) : undefined;
      if (last) return this.insert(last.end, `, ${name}`);
    }
    this.import(`import { ${name} } from '${agents}';`);
  }

  /** After the file's last import, or at its top. */
  import(line: string) {
    const last = this.source.statements.findLast((statement) => ts.isImportDeclaration(statement));
    if (last) this.insert(last.end, `\n${line}`);
    else this.insert(0, `${line}\n`);
  }

  /** After everything the setup registers. */
  last(line: string) {
    this.tail.push(line);
  }

  /** Before the first profile the setup registers, so every profile can allow it. */
  beforeProfiles(line: string) {
    const first = this.found.find(({ name }) => name === 'registerProfile');
    if (first) this.before(first.statement, [line]);
    else this.last(line);
  }

  /** The last lines: after the last profile, else the last registration, else in the setup's function, else at the end. */
  private placeTail() {
    const end = this.found.findLast(({ name }) => name === 'registerProfile') ?? this.found.at(-1);
    if (end) return this.after(end.statement, this.tail);
    const body = this.source.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.body !== undefined &&
      (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Default) !== 0
    )?.body;
    const within = body?.statements.at(-1);
    if (within) return this.after(within, this.tail);
    if (body) {
      const unit = indentUnit(this.source);
      return this.insert(body.getStart(this.source) + 1, `${this.tail.map((line) => `\n${unit}${line}`).join('')}\n`);
    }
    const { text } = this.source;
    this.insert(text.length, `${text && !text.endsWith('\n') ? '\n' : ''}${this.tail.join('\n')}\n`);
  }

  /** Every line placed, as edits to the setup. */
  finish(): SourceEdit[] {
    if (this.tail.length) this.placeTail();
    return this.edits;
  }
}

/** Where the new files import from, and what they must not collide with. */
interface Ground {
  project: ProjectSource;
  /** The file that registers the project's profiles. */
  source: ts.SourceFile;
  /** Where the project imports the kernel from, and the file that does. */
  agents: { specifier: string; file: string };
  exists: (path: string) => boolean;
}

/** The agent tools a new agent waits for or brings with it, and the registration it must come before. */
interface Calls {
  /** By new agent: the tools only new agents allow, registered right before it. */
  lead: Map<string, ToolRegistration[]>;
  /** By new agent: the tools that run it for an agent the project has, registered right after it. */
  trail: Map<string, ToolRegistration[]>;
  /** By new agent: the statement of the first agent the project has that calls it. */
  hoist: Map<string, ts.Statement>;
}

const held = (calls: Map<string, ToolRegistration[]>, agent: string) => calls.get(agent) ?? [];

/** One plan in the making: the files it creates, the setup lines, and what it could not place. */
class NewPlan {
  readonly plan: SavePlan = { changes: [], edits: [] };
  private readonly setup: Setup;
  private readonly taken: Set<string>;
  private readonly claimed = new Set<string>();
  private readonly placed = new Set<string>();
  private readonly extension: string;
  private readonly zod: { specifier: string; file: string };
  private readonly folders: Record<SaveChange['kind'], string>;
  private readonly isNew: Set<string>;

  constructor(private readonly ground: Ground, private readonly added: NewSubjects) {
    const { project, source, agents } = ground;
    const folder = (targets: Map<string, { file: string }[]>) =>
      commonFolder([...targets.values()].flat().map((target) => target.file), dirname(project.entry));
    this.setup = new Setup(project, source);
    this.taken = namesIn(source);
    this.extension = importExtension(project, agents.specifier);
    this.zod = importedFrom(project, ['z']) ?? { specifier: 'zod', file: project.entry };
    this.folders = { profile: folder(project.profiles), tool: folder(project.tools) };
    this.isNew = new Set(added.profiles);
  }

  private refuse(kind: SaveChange['kind'], of: string, status: SaveChange['status'], file: string) {
    this.plan.changes.push({ kind, of, setting: '', status, file });
  }

  private nowhere(registration: ToolRegistration) {
    this.refuse('tool', registration.name, 'setup', this.ground.project.entry);
  }

  /** Nothing can be placed: the setup does not show where it registers. */
  unplaced(): SavePlan {
    const { entry } = this.ground.project;
    for (const id of this.added.profiles) this.refuse('profile', id, 'setup', entry);
    for (const tool of this.added.tools) this.refuse('tool', tool.name, 'setup', entry);
    return this.plan;
  }

  /** The specifiers a new file at `file` imports the kernel and zod by. */
  private from(file: string) {
    const { agents } = this.ground;
    return {
      agents: carried(agents.specifier, agents.file, file),
      zod: carried(this.zod.specifier, this.zod.file, file),
    };
  }

  /** The new file for `of`, written and imported. False when it cannot be, with the reason planned. */
  private create(
    kind: SaveChange['kind'],
    of: string,
    text: (file: string) => string | undefined,
    imports: (specifier: string) => string,
  ): boolean {
    const { project, source, exists } = this.ground;
    const file = resolve(this.folders[kind], `${of}.ts`);
    const code = FILE_NAME.test(of) && isInside(project.root, file) ? text(file) : undefined;
    if (code === undefined) {
      this.refuse(kind, of, 'setup', project.entry);
      return false;
    }
    if (exists(file) || this.claimed.has(file)) {
      this.refuse(kind, of, 'taken', file);
      return false;
    }
    this.claimed.add(file);
    this.plan.edits.push({ file, start: 0, end: 0, text: code });
    this.setup.import(imports(specifierTo(source.fileName, file, this.extension)));
    this.plan.changes.push({ kind, of, setting: '', status: 'written', file, line: 1 });
    return true;
  }

  /** A tool's file, and the setup's call of the function in it that registers the tool. */
  private tool(registration: ToolRegistration): string[] {
    const register = registerName(registration.name, this.taken);
    const made = this.create(
      'tool',
      registration.name,
      (file) => toolModule(registration, register, this.from(file)),
      (specifier) => `import { ${register} } from '${specifier}';`,
    );
    return made ? [`${register}();`] : [];
  }

  /** Where an agent tool goes when an agent the project has allows it: `first` is the earliest of those agents. */
  private call(registration: ToolRegistration & { type: 'agent' }, first: ts.Statement, calls: Calls) {
    const { profile } = registration;
    if (this.isNew.has(profile)) {
      // An agent the project has calls a new one: the new agent and this tool go right before it.
      const earlier = calls.hoist.get(profile);
      calls.hoist.set(profile, earlier && earlier.pos < first.pos ? earlier : first);
      calls.trail.set(profile, [...held(calls.trail, profile), registration]);
      return;
    }
    const ran = this.setup.registers(profile);
    if (!ran || ran.end > first.getStart(this.ground.source)) return this.nowhere(registration);
    this.setup.after(ran, this.tool(registration));
  }

  /**
   * Places each new tool. One that calls no agent goes before every profile. An agent tool goes
   * after the agent it runs and before every agent that allows it, or waits for a new agent's line.
   */
  private tools(): Calls {
    const calls: Calls = { lead: new Map(), trail: new Map(), hoist: new Map() };
    for (const registration of this.added.tools) {
      if (registration.type !== 'agent') {
        for (const line of this.tool(registration)) this.setup.beforeProfiles(line);
        continue;
      }
      const callers = this.added.agents.filter((agent) =>
        agent.customTools.some(({ name }) => name === registration.name)
      );
      const fresh = callers.find((agent) => this.isNew.has(agent.agentId));
      const known = callers.filter((agent) => !this.isNew.has(agent.agentId))
        .map((agent) => this.setup.registers(agent.agentId));
      const found = known.filter((statement) => statement !== undefined).toSorted((a, b) => a.pos - b.pos);
      const [first] = found;
      // Only new agents allow it, and they are registered last: it goes right before the first of them.
      if (!known.length && fresh) calls.lead.set(fresh.agentId, [...held(calls.lead, fresh.agentId), registration]);
      else if (first && found.length === known.length) this.call(registration, first, calls);
      else this.nowhere(registration);
    }
    return calls;
  }

  /** A new agent's file and its lines in the setup, after any new agent it calls. */
  private agent(agent: CompiledStudio, calls: Calls) {
    if (this.placed.has(agent.agentId)) return;
    this.placed.add(agent.agentId);
    const { agents, source } = this.ground;
    const before = calls.hoist.get(agent.agentId);
    const waits = held(calls.lead, agent.agentId);
    for (const registration of waits) {
      const ran = registration.type === 'agent' && this.isNew.has(registration.profile)
        ? this.added.agents.find((other) => other.agentId === registration.profile)
        : undefined;
      if (ran) this.agent(ran, calls);
    }
    const name = agentIdentifier(agent.agentId, this.taken);
    const made = this.create(
      'profile',
      agent.agentId,
      (file) => {
        const code = agentModule(agent, this.from(file).agents);
        // The compiled patterns come from a path of the package, which only its own name reaches.
        return code.includes('compileDetect(') && agents.specifier !== AGENTS_PACKAGE ? undefined : code;
      },
      (specifier) => `import * as ${name} from '${specifier}';`,
    );
    const follows = held(calls.trail, agent.agentId);
    // An agent that goes before one the project has cannot wait for a tool of its own: that tool has no place.
    if (!made || (before && waits.length)) {
      for (const registration of [...waits, ...follows]) this.nowhere(registration);
      return;
    }
    const kernel = carried(agents.specifier, agents.file, source.fileName);
    const lines = waits.flatMap((registration) => this.tool(registration));
    if (agent.structured) {
      this.setup.needs('registerStructured', kernel);
      lines.push(`registerStructured(${name}.structured.id, ${name}.structured.spec);`);
    }
    this.setup.needs('registerProfile', kernel);
    lines.push(`registerProfile(${name}.profile);`, ...follows.flatMap((registration) => this.tool(registration)));
    if (before) this.setup.before(before, lines);
    else for (const line of lines) this.setup.last(line);
  }

  build(): SavePlan {
    if (!this.setup.plain) return this.unplaced();
    const calls = this.tools();
    for (const agent of this.added.agents) {
      if (this.isNew.has(agent.agentId)) this.agent(agent, calls);
    }
    this.plan.edits.push(...this.setup.finish());
    return this.plan;
  }
}

/**
 * Plans the files and setup lines for what the studio added. `exists` says whether a path is
 * taken. A change it cannot write says why, and nothing is planned for it.
 */
export function planNew(project: ProjectSource, added: NewSubjects, exists: (path: string) => boolean): SavePlan {
  if (!added.profiles.length && !added.tools.length) return { changes: [], edits: [] };
  const source = registeringFile(project);
  const agents = importedFrom(project, ['defineProfile', 'registerProfile', 'registerTool']);
  if (!source || !agents) {
    const changes = [
      ...added.profiles.map((of) => ({ kind: 'profile' as const, of })),
      ...added.tools.map(({ name }) => ({ kind: 'tool' as const, of: name })),
    ].map((change): SaveChange => ({ ...change, setting: '', status: 'setup', file: project.entry }));
    return { changes, edits: [] };
  }
  return new NewPlan({ project, source, agents, exists }, added).build();
}
