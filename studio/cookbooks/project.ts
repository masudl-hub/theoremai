/**
 * Composable Cookbook Projector: extracts and stitches profile facets, tool sub-objects,
 * and multi-agent systems from the canonical `COOKBOOKS` store into clean TypeScript source.
 *
 * @module
 */

import { type CompiledStudio, compileStudio } from '../compile.ts';
import { type CompiledWorkspace, compileWorkspace } from '../compile-workspace.ts';
import { ON_OWN_KEYS } from '../lent-keys.ts';
import { studioSource, valueSource } from '../source.ts';
import { keySource, quoteSource } from '../tool-schema.ts';
import {
  agentDraft,
  type StudioWorkspace,
  withAgentDraft,
  workspaceFromDraft,
} from '../workspace.ts';
import {
  COOKBOOKS,
  type CookbookId,
  createArchitectWorkspace,
  createConsoleExampleDraft,
  createExampleDraft,
  createGeminiEmbeddingExampleDraft,
  createLiveExampleDraft,
  createNarratorExampleDraft,
  createResearchWorkspace,
  createSpanExampleDraft,
  decisionExampleDraft,
} from './catalog.ts';

const SLICE_STYLE = { unit: '  ', base: '', template: false };

function syncWorkspace(cookbookId: CookbookId): StudioWorkspace {
  switch (cookbookId) {
    case 'research':
      return createResearchWorkspace();
    case 'concierge':
      return workspaceFromDraft(createExampleDraft());
    case 'architect':
      return createArchitectWorkspace();
    case 'live-concierge':
      return workspaceFromDraft(createLiveExampleDraft());
    case 'decision':
      return workspaceFromDraft(decisionExampleDraft());
    case 'span-decision':
      return workspaceFromDraft(createSpanExampleDraft());
    case 'gemini-embedding-2':
      return workspaceFromDraft(createGeminiEmbeddingExampleDraft());
    case 'narrator':
      return workspaceFromDraft(createNarratorExampleDraft());
    case 'console':
      return workspaceFromDraft(createConsoleExampleDraft());
  }
}

function compileFailed(what: string, issues: readonly { message: string }[]): Error {
  return new Error(`${what} failed to compile: ${issues.map((i) => i.message).join('; ')}`);
}

function compiledCookbook(cookbookId: CookbookId): CompiledWorkspace {
  const compiled = compileWorkspace(syncWorkspace(cookbookId), ON_OWN_KEYS);
  if (!compiled.ok) throw compileFailed(`Cookbook '${cookbookId}'`, compiled.issues);
  return compiled;
}

function compileCookbookAgent(cookbookId: CookbookId, agentId?: string): CompiledStudio {
  const compiled = compiledCookbook(cookbookId);
  const found = agentId
    ? compiled.agents.find((agent) => agent.agentId === agentId)
    : compiled.agents.at(-1);
  if (!found) {
    throw new Error(
      `Cookbook '${cookbookId}' has no agent '${agentId ?? ''}' (have: ${compiled.agents.map((a) => a.agentId).join(', ')})`,
    );
  }
  return found;
}

function formatPickedRecord(
  record: Record<string, unknown>,
  keys: readonly string[],
  asFields: boolean,
  callPrefix: string,
  callSuffix = ');',
): string {
  const picked = Object.fromEntries(
    keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]),
  );
  if (asFields) {
    return Object.entries(picked)
      .map(([key, value]) => `${keySource(key)}: ${valueSource(value, SLICE_STYLE)},`)
      .join('\n');
  }
  return `${callPrefix}${valueSource(picked, SLICE_STYLE)}${callSuffix}`;
}

export interface ProfileSliceOptions {
  /** Profile top-level keys to keep (e.g. `['identity', 'inputs']`). Omit for the whole profile. */
  pick?: readonly string[];
  /** Override `tools.allow` to a focused list of tool names for the slice. */
  toolsAllow?: readonly string[];
  /**
   * - `'fields'`: bare `key: value,` lines (for `ts frame=profile:<type>` fences).
   * - `'defineProfile'`: `const profile = defineProfile({ ... });`.
   * - `'module'`: full standalone module (`studioSource`).
   */
  mode?: 'fields' | 'defineProfile' | 'module';
}

/**
 * Projects a single profile (or a subset of its facets/fields) from a cookbook in `COOKBOOKS`.
 */
export function projectProfileSlice(
  cookbookId: CookbookId,
  agentId?: string,
  options: ProfileSliceOptions = {},
): string {
  const compiled = compileCookbookAgent(cookbookId, agentId);
  const mode = options.mode ?? (options.pick?.length ? 'fields' : 'defineProfile');
  const rawProfile = { ...(compiled.profile as unknown as Record<string, unknown>) };
  if (options.toolsAllow && 'tools' in rawProfile && rawProfile.tools) {
    rawProfile.tools = {
      ...(rawProfile.tools as Record<string, unknown>),
      allow: [...options.toolsAllow],
    };
  }
  if (mode === 'module') {
    const customTools = options.toolsAllow
      ? compiled.customTools.filter((tool) => options.toolsAllow?.includes(tool.name))
      : compiled.customTools;
    return studioSource({
      ...compiled,
      profile: rawProfile as CompiledStudio['profile'],
      customTools,
    });
  }
  const keys = options.pick?.length ? options.pick : Object.keys(rawProfile);
  return formatPickedRecord(rawProfile, keys, mode === 'fields', 'const profile = defineProfile(');
}

export type ToolSliceField =
  | 'type'
  | 'name'
  | 'description'
  | 'category'
  | 'access'
  | 'permission'
  | 'loadTier'
  | 'paths'
  | 'endpoint'
  | 'method'
  | 'headers'
  | 'mapping'
  | 'serverUrl'
  | 'mcpToolName'
  | 'session'
  | 'auth'
  | 'maxResponseBytes'
  | 'labels'
  | 'profile'
  | 'maxCallsPerTurn'
  | 'answeredBy';

export interface ToolSliceOptions {
  /** Sub-fields of the tool registration to project (e.g. `['auth']`, `['mapping', 'headers']`). */
  pick?: readonly ToolSliceField[];
  /**
   * - `'fields'`: bare `key: value,` lines (for focused explanations of `auth`, `mapping`, `labels`, etc.).
   * - `'registerTool'`: `registerTool({ ... });`.
   */
  mode?: 'fields' | 'registerTool';
}

/**
 * Projects a tool (or specific sub-objects of a tool, such as `auth`, `mapping`, `labels`) from `COOKBOOKS`.
 */
export function projectToolSlice(
  cookbookId: CookbookId,
  toolName: string,
  options: ToolSliceOptions = {},
): string {
  const compiled = compiledCookbook(cookbookId);
  const allTools = compiled.agents.flatMap((agent) => agent.customTools);
  const tool = allTools.find((entry) => entry.name === toolName);
  if (!tool) {
    throw new Error(`Cookbook '${cookbookId}' has no tool '${toolName}'`);
  }
  const mode = options.mode ?? (options.pick?.length ? 'fields' : 'registerTool');
  const record = tool as unknown as Record<string, unknown>;
  const keys = options.pick?.length
    ? options.pick
    : (Object.keys(record).filter(
        (key) => key !== 'inputSchema' && key !== 'outputSchema' && key !== 'stageAgent',
      ) as ToolSliceField[]);
  return formatPickedRecord(record, keys, mode === 'fields', 'registerTool(');
}

export interface StitchRecipe {
  agentId?: string;
  /** Optional subset of tools to include on the stitched profile. */
  toolsAllow?: readonly string[];
  /** Optional prompt for a `runTurn` entrypoint function. */
  runner?: {
    exportName: string;
    prompt: string;
    keySlot?: string;
  };
}

/**
 * Stitches a cookbook (or a focused tool/facet subset of it) into a complete runnable TypeScript program
 * and a matching `StudioWorkspace` for opening in Studio.
 */
export function stitchCookbook(
  cookbookId: CookbookId,
  recipe: StitchRecipe = {},
): { code: string; workspace: StudioWorkspace; question: string | undefined } {
  const ws = syncWorkspace(cookbookId);
  const targetAgent = recipe.agentId
    ? ws.agents.find((agent) => agent.identity.agentId === recipe.agentId)
    : ws.agents.at(0);
  const baseDraft = targetAgent ? agentDraft(ws, targetAgent.key) : undefined;
  if (!baseDraft || !targetAgent) {
    throw new Error(`Cookbook '${cookbookId}' could not resolve agent '${recipe.agentId ?? ''}'`);
  }
  const draft = recipe.toolsAllow
    ? {
        ...baseDraft,
        toolSpecs: baseDraft.toolSpecs
          .filter((tool) => recipe.toolsAllow?.includes(tool.toolName))
          .map(({ stageAgentKey: _stage, ...tool }) => tool),
      }
    : baseDraft;
  const compiled = compileStudio(draft, ON_OWN_KEYS);
  if (!compiled.ok) throw compileFailed(`Stitched cookbook '${cookbookId}'`, compiled.issues);
  let code = studioSource(compiled);
  if (recipe.runner) {
    const { exportName, prompt, keySlot = 'gemini' } = recipe.runner;
    code = code.replace(/\} from '@theoremjs\/agents';/, `  runTurn,\n} from '@theoremjs/agents';`);
    code = `${code}
export async function ${exportName}(apiKey: string) {
  const hostOptions = {
    vault: { ${keySource(keySlot)}: apiKey },
  };

  for await (const event of runTurn(
    {
      profile: ${quoteSource(compiled.agentId)},
      input: {
        text: ${quoteSource(prompt)},
      },
    },
    hostOptions,
  )) {
    if (event.type === 'text') process.stdout.write(event.text);
  }
}
`;
  }
  const workspace = recipe.toolsAllow
    ? withAgentDraft(
        { ...ws, agents: [targetAgent], toolSpecs: draft.toolSpecs },
        targetAgent.key,
        draft,
      )
    : ws;
  return {
    code,
    workspace,
    question: recipe.runner?.prompt ?? COOKBOOKS[cookbookId].question,
  };
}

/**
 * Resolves a declarative slice specifier (`<cookbook>:<target>[#<pick1>,<pick2>]`)
 * for `/docs` fences (`ts slice=...`).
 * Examples:
 * - `research:profile:research.scout#identity,inputs`
 * - `research:tool:search_github#headers,mapping`
 */
export function resolveCookbookSlice(spec: string): string {
  const [head = '', pickPart] = spec.split('#');
  const [cookbookRaw = '', kind = 'profile', target] = head.split(':');
  if (!(cookbookRaw in COOKBOOKS)) {
    throw new Error(`Unknown cookbook in slice '${spec}': '${cookbookRaw}'`);
  }
  const cookbookId = cookbookRaw as CookbookId;
  const pick = pickPart
    ? pickPart
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
  if (kind === 'tool') {
    if (!target) throw new Error(`Tool slice '${spec}' must name a tool: <cookbook>:tool:<name>`);
    return projectToolSlice(cookbookId, target, {
      ...(pick ? { pick: pick as ToolSliceField[] } : {}),
    });
  }
  return projectProfileSlice(cookbookId, target, {
    ...(pick ? { pick } : {}),
  });
}
