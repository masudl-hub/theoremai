/**
 * The builder's unsaved edits, laid over a load of the project: each changed setting set on the
 * profile or tool the project's own code registered, and each new agent and tool registered
 * beside them. Everything the builder did not change stays the project's, handlers and all, so a
 * run of this load differs from a run of the files only by the edits.
 *
 * @module
 */

import { z } from 'zod';
import { defineProfile, type KernelScope, type ProfileDefinition } from '../../mod.ts';
import type { RegisteredTool } from '../../src/kernel/tools/types.ts';
import type { CompiledStudio } from '../compile.ts';
import type { ToolRegistration } from '../registrations.ts';
import { withCompiledPatterns } from '../runtime-scope.ts';
import { registerCustomTool } from '../tools.ts';
import type { NewSubjects } from './save-new.ts';
import { canonical, type SaveSubject } from './save-plan.ts';

/** What the builder changed and added, as Save reads a workspace. */
export interface ProjectEdits {
  subjects: readonly SaveSubject[];
  added: NewSubjects;
}

type Json = Record<string, unknown>;

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

/** The project's tool with the builder's changes: its handler and everything unchanged stay its own. */
function editedTool(registered: RegisteredTool, before: ToolRegistration, after: ToolRegistration): RegisteredTool {
  const edited = { ...registered };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [was, is] = [(before as Json)[key], (after as Json)[key]];
    if (STUDIO_ONLY.has(key) || canonical(was) === canonical(is)) continue;
    const schema = SCHEMAS[key];
    if (schema) Object.assign(edited, { [schema]: asFileReads(is) });
    else if (is === undefined) Reflect.deleteProperty(edited, key);
    else Object.assign(edited, { [key]: is });
  }
  return edited;
}

/** A schema as a file Save writes holds it: read by zod from the JSON the builder wrote. */
const asFileReads = (schema: unknown) => z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);

function registerNew(scope: KernelScope, tool: ToolRegistration): void {
  registerCustomTool(scope.tools, tool, asFileReads);
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
  const registered = subject ? scope.profiles.find(subject.of) : undefined;
  const definition = registered
    ? withSettings(registered, profileChanges(subject?.before, subject?.after))
    : agent.profile;
  scope.profiles.register(defineProfile(await withCompiledPatterns(definition as ProfileDefinition)));
}

/**
 * Registers the edits over the project `scope` holds. Tools an agent runs go before it, and an
 * agent before the tool that calls it: the order the kernel checks them in.
 */
export async function registerEdits(scope: KernelScope, edits: ProjectEdits): Promise<void> {
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
