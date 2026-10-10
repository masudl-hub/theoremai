/**
 * The settings a project's files set in code, as the studio's editor reads
 * them: which rows of the open node show a value the studio does not change,
 * and where the file sets it.
 *
 * @module
 */

import { PROFILE_GRAPH } from '../src/kernel/schema.ts';
import type { OpenAnswer, ProjectOrigins, SettingOrigin } from './server/save-wire.ts';
import { type StudioWorkspace, workspaceNodeRef } from './workspace.ts';

/** The open node's settings that are set in code. */
export interface NodeOrigins {
  /** Those of the profile or tool the node belongs to. */
  origins: readonly SettingOrigin[];
  /** What a `*` in a row's path stands for here, by the path up to it: `models.*` is the open model's id. */
  stars: Record<string, string>;
  /** The node edits a tool: its rows name the tool's own settings. */
  tool: boolean;
  /** Set when one place in the files sets the whole node, so the editor says it once, over the rows. */
  section?: SettingOrigin;
  /**
   * Set when the files spread other code into the node's own settings: the rows the files do not
   * write after it are the spread's, so the editor says it once, over the rows.
   */
  partly?: SettingOrigin;
}

/** A tool row's path where it differs from the key `registerTool` holds. */
const TOOL_KEYS: Record<string, string> = {
  'registerTool.type': 'type',
  'studio.inputSchema': 'inputSchema',
  'studio.outputSchema': 'outputSchema',
};

/** Rows under these are the studio's own, and no file sets them. */
const STUDIO_ONLY = new Set(['studio', 'local']);

const isIndex = (key: string | undefined) => key !== undefined && /^\d+$/.test(key);

const startsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.length <= path.length && prefix.every((key, index) => path[index] === key);

/**
 * A row's catalog path as the keys the files hold: each `*` the node names is filled in, and the
 * path stops before one it does not. Undefined for a row no file sets.
 */
export function settingPath(scope: Pick<NodeOrigins, 'stars' | 'tool'>, catalogPath: string): string[] | undefined {
  const keys = ((scope.tool && TOOL_KEYS[catalogPath]) || catalogPath).split('.');
  if (STUDIO_ONLY.has(keys[0] ?? '')) return undefined;
  const path: string[] = [];
  for (const [index, key] of keys.entries()) {
    if (key !== '*') {
      path.push(key);
      continue;
    }
    const named = scope.stars[keys.slice(0, index + 1).join('.')];
    if (named === undefined) break;
    path.push(named);
  }
  return path;
}

/** Whether an origin at or above `path` keeps the studio from writing it. */
function holds(origin: SettingOrigin, path: readonly string[]): boolean {
  if (!startsWith(path, origin.path)) return false;
  if (origin.kind !== 'spread') return true;
  // Past a spread, the studio writes the keys the file writes after it.
  const key = path[origin.path.length];
  return key === undefined || !origin.written?.includes(key);
}

/**
 * The origin that sets the value at `path`: the nearest one at or above it, or one that sets an
 * entry of the list at `path`, since a row edits its list as a whole.
 */
export function originAt(origins: readonly SettingOrigin[], path: readonly string[]): SettingOrigin | undefined {
  const above = origins.filter((origin) => holds(origin, path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (above) return above;
  return origins.find((origin) => startsWith(origin.path, path) && isIndex(origin.path[path.length]));
}

/** The origin of the row at a catalog path, when the files set it in code. */
export function rowOrigin(scope: NodeOrigins | undefined, catalogPath: string): SettingOrigin | undefined {
  const path = scope && settingPath(scope, catalogPath);
  return path && scope ? originAt(scope.origins, path) : undefined;
}

/** The id or name the project's files know a started agent, model or tool by. */
function started(workspace: StudioWorkspace, agentKey: string) {
  const agent = workspace.starts.agents[agentKey];
  return {
    id: agent?.identity.agentId.trim(),
    model: (key: string) => agent?.modelBindings.find((binding) => binding.key === key)?.modelId.trim(),
  };
}

/**
 * The settings set in code for the node `nodeId` opens. Undefined when the project's files do not
 * hold the node's profile or tool: one added in the studio.
 */
export function nodeOrigins(
  workspace: StudioWorkspace,
  project: ProjectOrigins,
  nodeId: string,
): NodeOrigins | undefined {
  const node = workspaceNodeRef(workspace, nodeId);
  if (!node) return undefined;
  if ('tool' in node) {
    const name = workspace.starts.tools[node.tool]?.toolName;
    const origins = name === undefined ? undefined : project.tools[name];
    return origins && withSection({ origins, stars: {}, tool: true }, []);
  }
  const start = started(workspace, node.agent);
  const origins = start.id === undefined ? undefined : project.profiles[start.id];
  if (!origins) return undefined;
  const stars: Record<string, string> = {};
  if (node.ref.facet === 'modelBinding') {
    const model = start.model(node.ref.key);
    if (model) stars['models.*'] = model;
  }
  const scope = { origins, stars, tool: false };
  const facet = PROFILE_GRAPH.find((each) => each.id === node.ref.facet);
  // A section whose `*` names nothing in the files (a model added in the studio) is read at the key above it.
  return withSection(scope, (facet && settingPath(scope, facet.profilePath)) ?? []);
}

/**
 * `scope` with the one origin that sets the whole section at `path`: at or above the section's own
 * key. A spread in the section itself is not one, since the rows it leaves written stay open.
 */
function withSection(scope: NodeOrigins, path: readonly string[]): NodeOrigins {
  const own = (origin: SettingOrigin) => origin.kind === 'spread' && origin.path.length === path.length;
  const above = scope.origins.filter((origin) => holds(origin, path));
  const section = above.filter((origin) => !own(origin)).sort((a, b) => b.path.length - a.path.length)[0];
  if (section) return { ...scope, section };
  const partly = above.find(own);
  return partly ? { ...scope, partly } : scope;
}

/** Where an origin is, as `file:line`. */
export function originPlace(origin: SettingOrigin): string | undefined {
  if (!origin.file) return undefined;
  return origin.line ? `${origin.file}:${String(origin.line)}` : origin.file;
}

/** What a row says of its origin, before the place: `Set in code · bonsaiInputs()`. */
export function originLabel(origin: SettingOrigin): string {
  switch (origin.kind) {
    case 'constant':
      return `Set by ${origin.text ?? 'a constant'}, which other code reads`;
    case 'twice':
      return 'Defined more than once in your files';
    case 'unfound':
      return 'Not defined where the studio reads';
    default:
      return origin.text ? `Set in code · ${origin.text}` : 'Set in code';
  }
}

/** What the builder does about an origin with no place to open. */
export function originWay(origin: SettingOrigin): string {
  if (origin.kind === 'unfound') {
    return 'Define it with defineProfile or registerTool, in a file your setup imports by a relative path.';
  }
  return 'Edit it in your files.';
}

/** What the page says once it asked for a place in the builder's editor. */
export function openOutcome(answer: OpenAnswer, place: string): string {
  if (answer.ok && answer.byDefault) {
    return `Opened in your default editor: ${place}. To open on the line, start the studio with --editor.`;
  }
  if (answer.ok) return `Opened ${place} in ${answer.editor}.`;
  const how = 'Start the studio with --editor and the command of an editor that opens a window: code, cursor, zed.';
  switch (answer.reason) {
    case 'file':
      return `${place} is not a file your setup reads now. Reload the studio.`;
    case 'editor':
      return `The studio cannot start ${answer.editor || 'that editor'} on a line. ${how}`;
    default:
      return `${answer.editor ?? 'Your editor'} did not start. ${how}`;
  }
}
