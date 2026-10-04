import { TheoremError } from '../../guardrails/error.ts';
import type {
  ModelId,
  ModelProfile,
  Profile,
  ProfileToolsSpec,
  ToolId,
  TurnRequest,
} from '../types.ts';
import { isRecord } from '../util/record.ts';
import type { ToolRegistry } from './registry.ts';
import type {
  PromoteLoadedResult,
  RegisteredTool,
  ToolFailure,
  TurnToolSnapshot,
  WireFunctionTool,
} from './types.ts';

/** Callable by the host: registered, and not a provider-run builtin. */
function isExecutable(tools: ToolRegistry, id: ToolId): boolean {
  const tool = tools.get(id);
  return tool !== undefined && tool.type !== 'builtin';
}

export function pathMatches(catalogPaths?: string[], turnPath?: string): boolean {
  if (!catalogPaths || catalogPaths.includes('*')) {
    return true;
  }
  if (!turnPath) {
    return false;
  }
  return catalogPaths.includes(turnPath);
}

export function applyBuiltinMutualExclusions(tools: ToolRegistry, requested: string[]): string[] {
  return requested.filter((id) => {
    const tool = tools.get(id);
    if (tool?.type !== 'builtin') {
      return true;
    }
    const conflicts = tool.conflictsWith ?? [];
    return !conflicts.some((other) => requested.includes(other));
  });
}

export function profileToolAllow(profile: Profile): readonly ToolId[] {
  return 'tools' in profile ? profile.tools.allow : [];
}

export function profileToolsSpec(profile: Profile): ProfileToolsSpec | undefined {
  return profile.type === 'text' || profile.type === 'image' ? profile.tools : undefined;
}

export function resolveAllowedCustomToolIds(
  tools: ToolRegistry,
  profile: Profile,
  req: TurnRequest,
): ToolId[] {
  return profileToolAllow(profile).filter((id) => {
    const tool = tools.get(id);
    if (!tool || tool.type === 'builtin') {
      return false;
    }
    return profile.type === 'host' || pathMatches(tool.paths, req.path);
  });
}

export function resolveModelBuiltinIds(
  tools: ToolRegistry,
  profile: ModelProfile,
  req: TurnRequest,
  modelId: ModelId,
): ToolId[] {
  const spec = profile.models[modelId];
  if (!spec) {
    return [];
  }
  return (spec.builtInTools ?? []).filter((id) => {
    const tool = tools.get(id);
    if (tool?.type !== 'builtin') {
      return false;
    }
    return pathMatches(tool.paths, req.path);
  });
}

export function wireForTool(tools: ToolRegistry, name: string): WireFunctionTool | undefined {
  const tool = tools.get(name);
  if (!tool || tool.type === 'builtin') {
    return undefined;
  }
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

export function buildWire(tools: ToolRegistry, visible: ToolId[]): WireFunctionTool[] {
  const out: WireFunctionTool[] = [];
  for (const id of visible) {
    const wire = wireForTool(tools, id);
    if (wire) {
      out.push(wire);
    }
  }
  return out;
}

export function promoteTool(tools: ToolRegistry, state: TurnToolSnapshot, id: ToolId): void {
  if (state.visible.includes(id)) {
    return;
  }
  state.visible.push(id);
  const wire = wireForTool(tools, id);
  if (wire && !state.wire.some((w) => w.name === id)) {
    state.wire.push(wire);
  }
}

export function promoteBuiltin(tools: ToolRegistry, state: TurnToolSnapshot, id: ToolId): void {
  if (state.builtins.includes(id)) {
    return;
  }
  const tool = tools.get(id);
  if (tool?.type !== 'builtin') {
    return;
  }
  const conflicts = tool.conflictsWith ?? [];
  state.builtins = state.builtins.filter((existing) => {
    if (conflicts.includes(existing)) {
      return false;
    }
    const existingTool = tools.get(existing);
    return !(existingTool?.type === 'builtin' && existingTool.conflictsWith?.includes(id));
  });
  state.builtins.push(id);
}

/** Live declarations are fixed at session setup, so every allowed tool there is effectively T0. */
export function initialVisible(tools: ToolRegistry, profile: Profile, gated: ToolId[]): ToolId[] {
  if (profile.type === 'live' || profile.type === 'host') {
    return [...gated];
  }
  return gated.filter((id) => tools.get(id)?.loadTier === 'T0');
}

export function initialBuiltins(tools: ToolRegistry, profile: Profile, gated: ToolId[]): ToolId[] {
  return applyBuiltinMutualExclusions(
    tools,
    gated.filter((id) => {
      const tool = tools.get(id);
      return tool?.type === 'builtin' && (profile.type === 'live' || tool.loadTier === 'T0');
    }),
  );
}

export function resolveTurnTools(
  tools: ToolRegistry,
  profile: Profile,
  req: TurnRequest,
  modelId: ModelId | undefined,
): TurnToolSnapshot {
  const customAllowed = resolveAllowedCustomToolIds(tools, profile, req);
  const modelBuiltins =
    profile.type === 'host' || profile.type === 'decision' || modelId === undefined
      ? []
      : resolveModelBuiltinIds(tools, profile, req, modelId);
  const gated = [...customAllowed, ...modelBuiltins];
  const builtins = initialBuiltins(tools, profile, gated);
  const visible = initialVisible(tools, profile, gated);
  const executable = visible.filter((id) => isExecutable(tools, id));
  return {
    builtins,
    gated,
    visible,
    executable,
    path: req.path,
    sessionPermissions: req.sessionPermissions,
    wire: buildWire(tools, visible),
  };
}

/** Resolves the tools a turn may call into a snapshot, then applies the profile's `t1Policy` to it. */
export async function prepareTurnToolSnapshot(
  tools: ToolRegistry,
  profile: Profile,
  req: TurnRequest,
  modelId: ModelId | undefined,
): Promise<TurnToolSnapshot> {
  const snapshot = resolveTurnTools(tools, profile, req, modelId);
  await expandT1Policy(tools, snapshot, profile, req);
  return snapshot;
}

/** So concurrent host invokes do not share mutable state. */
export function cloneTurnToolSnapshot(state: TurnToolSnapshot): TurnToolSnapshot {
  return {
    builtins: [...state.builtins],
    gated: [...state.gated],
    visible: [...state.visible],
    executable: [...state.executable],
    path: state.path,
    sessionPermissions: state.sessionPermissions ? [...state.sessionPermissions] : undefined,
    wire: state.wire.map((w) => ({ ...w, parameters: structuredClone(w.parameters) })),
  };
}

export async function expandT1Policy(
  tools: ToolRegistry,
  state: TurnToolSnapshot,
  profile: Profile,
  req: TurnRequest,
): Promise<void> {
  const t1Policy = profileToolsSpec(profile)?.t1Policy;
  if (!t1Policy) {
    return;
  }
  let selected: ToolId[];
  try {
    selected = await t1Policy({
      profile,
      input: req.input,
      path: req.path,
      sessionPermissions: req.sessionPermissions,
      gated: state.gated,
      host: req.host,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TheoremError('config', `Profile '${profile.id}' tools.t1Policy rejected: ${msg}`, {
      cause: err,
    });
  }
  if (!Array.isArray(selected)) {
    throw new TheoremError('config', `Profile '${profile.id}' tools.t1Policy must return ToolId[]`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  for (const id of selected) {
    if (!state.gated.includes(id)) {
      continue;
    }
    const tool = tools.get(id);
    if (tool?.loadTier !== 'T1') {
      continue;
    }
    if (tool.type === 'builtin') {
      promoteBuiltin(tools, state, id);
    } else {
      promoteTool(tools, state, id);
    }
  }
  state.executable = state.visible.filter((id) => isExecutable(tools, id));
}

const LOADED_ID_BLOCKLIST = new Set(['__proto__', 'constructor', 'prototype']);

export function extractLoadedIds(output: unknown): string[] | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  const { loaded } = output;
  if (!Array.isArray(loaded) || !loaded.every((id) => typeof id === 'string')) {
    return undefined;
  }
  return loaded;
}

export function promoteLoadedTools(
  tools: ToolRegistry,
  state: TurnToolSnapshot,
  loaded: string[],
  profile: Profile,
): PromoteLoadedResult {
  if (profile.type === 'live' || profile.type === 'host') {
    return { promoted: [] };
  }
  const toPromote: ToolId[] = [];
  for (const id of loaded) {
    if (typeof id !== 'string' || LOADED_ID_BLOCKLIST.has(id)) {
      return {
        promoted: [],
        failure: {
          code: 'invalid_output',
          kind: 'bad_response',
          message: 'tools.t2Loader loaded ids must be plain strings', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        },
      };
    }
    const target = promotionTarget(tools, id, profile);
    if ('failure' in target) {
      return { promoted: [], failure: target.failure };
    }
    const { tool } = target;
    if (!pathMatches(tool.paths, state.path) || !state.gated.includes(id)) {
      continue;
    }
    toPromote.push(id);
  }
  const promoted: ToolId[] = [];
  for (const id of toPromote) {
    promoteTool(tools, state, id);
    promoted.push(id);
  }
  state.executable = state.visible.filter((id) => isExecutable(tools, id));
  return { promoted };
}

function promotionRefused(message: string): { failure: ToolFailure } {
  return { failure: { code: 'invalid_output', kind: 'bad_response', message } };
}

export function promotionTarget(
  tools: ToolRegistry,
  id: string,
  profile: Profile,
): { tool: RegisteredTool } | { failure: ToolFailure } {
  if (!profileToolAllow(profile).includes(id)) {
    return promotionRefused(
      `tools.t2Loader attempted to promote tool '${id}' outside profile allow`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const tool = tools.get(id);
  if (!tool) {
    return promotionRefused(
      `tools.t2Loader attempted to promote unknown tool '${id}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (tool.type === 'builtin') {
    return promotionRefused(
      `tools.t2Loader attempted to promote builtin '${id}' — only custom tools may be promoted`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (tool.loadTier !== 'T2') {
    return promotionRefused(
      `tools.t2Loader attempted to promote tool '${id}' with loadTier '${tool.loadTier}' — only T2 tools may be promoted`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  return { tool };
}
