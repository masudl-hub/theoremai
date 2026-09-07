/**
 * Turn tool visibility and wire snapshot resolution.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import type { ModelId, Profile, ToolId, TurnRequest } from '../types.ts';
import { getTool } from './registry.ts';
import type {
  PromoteLoadedResult,
  ToolFailure,
  TurnToolSnapshot,
  WireFunctionTool,
} from './types.ts';

export function pathMatches(catalogPaths?: string[], turnPath?: string): boolean {
  if (!catalogPaths || catalogPaths.includes('*')) {
    return true;
  }
  if (!turnPath) {
    return false;
  }
  return catalogPaths.includes(turnPath);
}

export function applyBuiltinMutualExclusions(requested: string[]): string[] {
  return requested.filter((id) => {
    const tool = getTool(id);
    if (tool?.type !== 'builtin') {
      return true;
    }
    const conflicts = tool.conflictsWith ?? [];
    return !conflicts.some((other) => requested.includes(other));
  });
}

export function resolveAllowedCustomToolIds(profile: Profile, req: TurnRequest): ToolId[] {
  if (profile.type === 'speech') {
    return [];
  }
  return profile.tools.allow.filter((id) => {
    const tool = getTool(id);
    if (!tool || tool.type === 'builtin') {
      return false;
    }
    return pathMatches(tool.paths, req.path);
  });
}

/** Provider builtins listed on the selected model — on for the turn (path-filtered). */
export function resolveModelBuiltinIds(
  profile: Profile,
  req: TurnRequest,
  modelId: ModelId,
): ToolId[] {
  const spec = profile.models[modelId];
  if (!spec) {
    return [];
  }
  return (spec.builtInTools ?? []).filter((id) => {
    const tool = getTool(id);
    if (tool?.type !== 'builtin') {
      return false;
    }
    return pathMatches(tool.paths, req.path);
  });
}

export function wireForTool(name: string): WireFunctionTool | undefined {
  const tool = getTool(name);
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

export function buildWire(visible: ToolId[]): WireFunctionTool[] {
  const out: WireFunctionTool[] = [];
  for (const id of visible) {
    const wire = wireForTool(id);
    if (wire) {
      out.push(wire);
    }
  }
  return out;
}

export function promoteTool(state: TurnToolSnapshot, id: ToolId): void {
  if (state.visible.includes(id)) {
    return;
  }
  state.visible.push(id);
  const wire = wireForTool(id);
  if (wire && !state.wire.some((w) => w.name === id)) {
    state.wire.push(wire);
  }
}

export function promoteBuiltin(state: TurnToolSnapshot, id: ToolId): void {
  if (state.builtins.includes(id)) {
    return;
  }
  const tool = getTool(id);
  if (tool?.type !== 'builtin') {
    return;
  }
  const conflicts = tool.conflictsWith ?? [];
  state.builtins = state.builtins.filter((existing) => {
    if (conflicts.includes(existing)) {
      return false;
    }
    const existingTool = getTool(existing);
    return !(existingTool?.type === 'builtin' && existingTool.conflictsWith?.includes(id));
  });
  state.builtins.push(id);
}

export function initialVisible(gated: ToolId[]): ToolId[] {
  return gated.filter((id) => getTool(id)?.loadTier === 'T0');
}

export function initialBuiltins(gated: ToolId[]): ToolId[] {
  return applyBuiltinMutualExclusions(
    gated.filter((id) => {
      const tool = getTool(id);
      return tool?.type === 'builtin' && tool.loadTier === 'T0';
    }),
  );
}

/** Build the initial tool snapshot for a turn (T0 wired; T1/T2 pending). */
export function resolveTurnTools(
  profile: Profile,
  req: TurnRequest,
  modelId: ModelId,
): TurnToolSnapshot {
  const customAllowed = resolveAllowedCustomToolIds(profile, req);
  const modelBuiltins = resolveModelBuiltinIds(profile, req, modelId);
  const gated = [...customAllowed, ...modelBuiltins];
  const builtins = initialBuiltins(gated);
  const visible = initialVisible(gated);
  const executable = visible.filter((id) => getTool(id)?.type !== 'builtin');
  return {
    builtins,
    gated,
    visible,
    executable,
    path: req.path,
    sessionPermissions: req.sessionPermissions,
    wire: buildWire(visible),
  };
}

/** Resolve T0 snapshot and expand T1 selections from `profile.tools.t1Policy`. */
export async function prepareTurnToolSnapshot(
  profile: Profile,
  req: TurnRequest,
  modelId: ModelId,
): Promise<TurnToolSnapshot> {
  const snapshot = resolveTurnTools(profile, req, modelId);
  await expandT1Policy(snapshot, profile, req);
  return snapshot;
}

/** Deep-clone a turn snapshot so host-side concurrent invokes do not share mutable state. */
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

/** Wire T1 tools selected by `profile.tools.t1Policy`. */
export async function expandT1Policy(
  state: TurnToolSnapshot,
  profile: Profile,
  req: TurnRequest,
): Promise<void> {
  if (profile.type === 'speech' || profile.type === 'live') {
    return;
  }
  const t1Policy = profile.tools.t1Policy;
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
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TheorumError(`Profile '${profile.id}' tools.t1Policy rejected: ${msg}`, {
      cause: err,
    });
  }
  if (!Array.isArray(selected)) {
    throw new TheorumError(`Profile '${profile.id}' tools.t1Policy must return ToolId[]`);
  }
  for (const id of selected) {
    if (!state.gated.includes(id)) {
      continue;
    }
    const tool = getTool(id);
    // T0 tools are already visible; t1Policy may promote T1/T2 gated tools at turn start.
    if (!tool || tool.loadTier === 'T0') {
      continue;
    }
    if (tool.type === 'builtin') {
      promoteBuiltin(state, id);
    } else {
      promoteTool(state, id);
    }
  }
  state.executable = state.visible.filter((id) => getTool(id)?.type !== 'builtin');
}

const LOADED_ID_BLOCKLIST = new Set(['__proto__', 'constructor', 'prototype']);

/** Promote T2 tools into the visible set after tools.t2Loader returns { loaded }. */
export function promoteLoadedTools(
  state: TurnToolSnapshot,
  loaded: string[],
  profile: Profile,
): PromoteLoadedResult {
  const toPromote: ToolId[] = [];
  for (const id of loaded) {
    if (typeof id !== 'string' || LOADED_ID_BLOCKLIST.has(id)) {
      return {
        promoted: [],
        failure: {
          code: 'invalid_output',
          message: 'tools.t2Loader loaded ids must be plain strings',
        },
      };
    }
    const failure = promotionFailure(id, profile);
    if (failure) {
      return { promoted: [], failure };
    }
    const tool = getTool(id);
    if (!tool) {
      return {
        promoted: [],
        failure: {
          code: 'invalid_output',
          message: `Tool '${id}' is not registered`,
        },
      };
    }
    if (!pathMatches(tool.paths, state.path) || !state.gated.includes(id)) {
      continue;
    }
    toPromote.push(id);
  }
  const promoted: ToolId[] = [];
  for (const id of toPromote) {
    promoteTool(state, id);
    promoted.push(id);
  }
  state.executable = state.visible.filter((tid) => getTool(tid)?.type !== 'builtin');
  return { promoted };
}

export function promotionFailure(id: string, profile: Profile): ToolFailure | undefined {
  if (profile.type === 'speech' || !profile.tools.allow.includes(id)) {
    return {
      code: 'invalid_output',
      message: `tools.t2Loader attempted to promote tool '${id}' outside profile allow`,
    };
  }
  const tool = getTool(id);
  if (!tool) {
    return {
      code: 'invalid_output',
      message: `tools.t2Loader attempted to promote unknown tool '${id}'`,
    };
  }
  if (tool.type === 'builtin') {
    return {
      code: 'invalid_output',
      message: `tools.t2Loader attempted to promote builtin '${id}' — only custom tools may be promoted`,
    };
  }
  if (tool.loadTier !== 'T2') {
    return {
      code: 'invalid_output',
      message: `tools.t2Loader attempted to promote tool '${id}' with loadTier '${tool.loadTier}' — only T2 tools may be promoted`,
    };
  }
  return undefined;
}
