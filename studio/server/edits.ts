/**
 * The builder's unsaved edits, laid over a load of the project: each changed setting set on the
 * profile or tool the project's own code registered, and each new agent and tool registered
 * beside them. Everything the builder did not change stays the project's, handlers and all, so a
 * run of this load differs from a run of the files only by the edits.
 *
 * @module
 */

import { defineProfile, type KernelScope, type ProfileDefinition } from '@theoremjs/agents';
import type { RegisteredTool } from '@theoremjs/agents/kernel';
import type { CompiledStudio } from '../compile.ts';
import { heldSetting, unheldProblem } from '../held-credentials.ts';
import type { ToolRegistration } from '../registrations.ts';
import { providerDefinition, type StudioProvider } from '../providers.ts';
import type { ProjectQuestions } from './handler.ts';
import { withCompiledPatterns } from '../runtime-scope.ts';
import { zodFromJsonSchema, type JsonSchema } from '../tool-schema.ts';
import { registerCustomTool } from '../tools.ts';
import type { NewSubjects } from './save-new.ts';
import { canonical } from '../canonical.ts';
import type { SaveSubject } from './save-plan.ts';

/** What the builder changed and added, as Save reads a workspace. */
export interface ProjectEdits {
  subjects: readonly SaveSubject[];
  added: NewSubjects;
}

type Json = Record<string, unknown>;

/**
 * What each decision is asked in the edited load: the questions the setup names, and for a
 * decision the setup does not name (one the builder added, renamed or made a decision) the ones
 * on the page.
 */
export function editedQuestions(edits: ProjectEdits, named: ProjectQuestions = {}): ProjectQuestions {
  const asked: ProjectQuestions = { ...named };
  for (const agent of edits.added.agents) {
    if (agent.questions && !asked[agent.agentId]) asked[agent.agentId] = agent.questions;
  }
  return asked;
}

/** One setting that differs: where it is, and its value now. No value when it was taken away. */
export interface Change {
  path: readonly string[];
  value?: unknown;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The settings that differ between two compiled values. A list that differs is one setting. */
export function changedSettings(before: unknown, after: unknown, path: readonly string[] = []): Change[] {
  if (canonical(before) === canonical(after)) return [];
  if (!isRecord(before) || !isRecord(after)) return after === undefined ? [{ path }] : [{ path, value: after }];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .flatMap((key) => changedSettings(before[key], after[key], [...path, key]));
}

/** `held` with one setting changed. What the path does not lead through is the same object as before. */
function withSetting(held: unknown, [key, ...rest]: readonly string[], change: Change): unknown {
  if (key === undefined) return change.value;
  const { [key]: inner, ...others } = isRecord(held) ? held : {};
  if (rest.length === 0 && !('value' in change)) return others;
  return { ...others, [key]: withSetting(inner, rest, change) };
}

const withSettings = (held: unknown, changes: readonly Change[]) =>
  changes.reduce((current, change) => withSetting(current, change.path, change), held);

/** A settings group the kernel reads as a whole: one changed setting inside it replaces the group. */
const WHOLE: readonly (readonly string[])[] = [['guardrails', 'detect']];

const leads = (group: readonly string[], path: readonly string[]) => group.every((key, at) => path[at] === key);
const at = (held: unknown, path: readonly string[]) =>
  path.reduce<unknown>((inner, key) => (isRecord(inner) ? inner[key] : undefined), held);

/** The profile's changes, with every change inside a whole group made one change of the group. */
function profileChanges(before: unknown, after: unknown): Change[] {
  const found = changedSettings(before, after);
  const groups = WHOLE.filter((group) => found.some((change) => leads(group, change.path)));
  return [
    ...found.filter((change) => !groups.some((group) => leads(group, change.path))),
    ...groups.map((path): Change => {
      const value = at(after, path);
      return value === undefined ? { path } : { path, value };
    }),
  ];
}

/** The settings of a tool that only the studio holds: the kernel's registration has no place for them. */
const STUDIO_ONLY = new Set(['stubResponse']);
/** A tool's schema, and the field the kernel holds it in. */
const SCHEMAS: Record<string, 'input' | 'output'> = { inputSchema: 'input', outputSchema: 'output' };

/** `tool`, refused when it shows a credential nothing holds a value for: a call must not carry a mask. */
function held<T extends { name: string }>(tool: T): T {
  const problem = unheldProblem(tool.name, tool);
  if (problem) throw new Error(problem);
  return tool;
}

/** The project's tool with the builder's changes: its handler and everything unchanged stay its own. */
function editedTool(registered: RegisteredTool, before: ToolRegistration, after: ToolRegistration): RegisteredTool {
  const edited = { ...registered };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [was, is] = [(before as Json)[key], (after as Json)[key]];
    if (STUDIO_ONLY.has(key) || canonical(was) === canonical(is)) continue;
    const schema = SCHEMAS[key];
    if (schema) Object.assign(edited, { [schema]: zodFromJsonSchema(is as JsonSchema) });
    else if (is === undefined) Reflect.deleteProperty(edited, key);
    // A credential the page holds masked is the project's own: the edit beside it keeps it.
    else Object.assign(edited, { [key]: heldSetting(key, is, (registered as unknown as Json)[key]) });
  }
  return held(edited);
}

function registerNew(scope: KernelScope, tool: ToolRegistration): void {
  registerCustomTool(scope.tools, held(tool));
}

function registerTool(scope: KernelScope, tool: ToolRegistration, subject: SaveSubject | undefined): void {
  const registered = subject ? scope.tools.get(subject.of) : undefined;
  const before = subject?.before as ToolRegistration | undefined;
  // A tool that became another kind keeps nothing of the old one.
  if (!registered || before?.type !== tool.type) registerNew(scope, tool);
  else scope.tools.register(editedTool(registered, before, tool));
}

async function registerAgent(scope: KernelScope, agent: CompiledStudio, subject: SaveSubject | undefined): Promise<void> {
  if (agent.structured && agent.profile.type !== 'live') scope.schemas.register(agent.structured.id, agent.structured.spec);
  const held = subject ? scope.profiles.find(subject.of) : undefined;
  // An agent that became another type keeps nothing of the old one: the kernel filled the old
  // type's own settings in, and the new type refuses them.
  const registered = held?.type === agent.profile.type ? held : undefined;
  const definition = registered
    ? withSettings(registered, profileChanges(subject?.before, subject?.after))
    : agent.profile;
  scope.profiles.register(defineProfile(await withCompiledPatterns(definition as ProfileDefinition)));
}

/**
 * A provider with the builder's edits over the one the project registered. What the page was not
 * shown stays as registered: anything it connects with that is not text. Told something else
 * about what its models support, its adapter is made again with that. Moved to another kernel
 * adapter, it is that adapter with what the page holds.
 */
function registerProvider(scope: KernelScope, subject: SaveSubject): void {
  const { model: _model, ...registered } = scope.providers.require(subject.of);
  const [before, after] = [subject.before as Json, subject.after as Json];
  if (after.adapter !== before.adapter) {
    // On another adapter, nothing the project connected with before carries over.
    scope.providers.register(providerDefinition({ ...(after as Omit<StudioProvider, 'id'>), id: subject.of }));
    return;
  }
  const [shown, edited] = [isRecord(before.connection) ? before.connection : {}, isRecord(after.connection) ? after.connection : {}];
  const connection: Json = { ...(isRecord(registered.connection) ? registered.connection : {}) };
  for (const key of new Set([...Object.keys(shown), ...Object.keys(edited)])) {
    if (key in edited) connection[key] = edited[key];
    else delete connection[key];
  }
  const { keySlot: _keySlot, fallbackKeySlot: _fallbackKeySlot, ...rest } = registered;
  // Told something else about its models, the adapter is made again with what the page holds.
  const told = canonical(before.support) === canonical(after.support) ? {} : {
    adapter: providerDefinition({
      id: subject.of,
      adapter: String(after.adapter),
      // As registered, with the edits: the adapter's own schema reads it.
      connection: connection as Record<string, string>,
      support: after.support as StudioProvider['support'],
    }).adapter,
  };
  scope.providers.register({
    ...rest,
    ...told,
    connection,
    ...(typeof after.keySlot === 'string' ? { keySlot: after.keySlot } : {}),
    ...(typeof after.fallbackKeySlot === 'string' ? { fallbackKeySlot: after.fallbackKeySlot } : {}),
  });
}

/**
 * Registers the edits over the project `scope` holds. A provider goes before the agents whose
 * models name it, tools an agent runs before it, and an agent before the tool that calls it: the
 * order the kernel checks them in.
 */
export async function registerEdits(scope: KernelScope, edits: ProjectEdits): Promise<void> {
  for (const provider of edits.added.providers) scope.providers.register(providerDefinition(provider));
  for (const held of edits.subjects) if (held.kind === 'provider') registerProvider(scope, held);
  const subject = (kind: SaveSubject['kind'], named: (after: Json) => unknown, name: string) =>
    edits.subjects.find((held) => held.kind === kind && named(held.after as Json) === name);
  const fresh = new Set(edits.added.tools.map((tool) => tool.name));
  const done = new Set<string>();
  const tool = (held: ToolRegistration) => {
    if (done.has(held.name)) return;
    done.add(held.name);
    const changed = subject('tool', (after) => after.name, held.name);
    if (changed || fresh.has(held.name)) registerTool(scope, held, changed);
  };
  const agents = edits.added.agents;
  for (const agent of agents) for (const held of agent.customTools) if (held.type !== 'agent') tool(held);
  for (const agent of agents) {
    for (const held of agent.customTools) tool(held);
    const changed = subject('profile', (after) => after.id, agent.agentId);
    if (changed || edits.added.profiles.includes(agent.agentId)) await registerAgent(scope, agent, changed);
  }
}
