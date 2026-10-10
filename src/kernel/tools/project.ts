import type { OwnTools } from '../../guardrails/tool-leak.ts';
import type { Profile, ToolId } from '../types.ts';
import type { ToolRegistry } from './registry.ts';
import { profileToolAllow } from './resolve.ts';
import type { RegisteredTool } from './types.ts';

function projectTool(
  tools: ToolRegistry,
  name: ToolId,
): RegisteredTool | { name: ToolId; missing: true } {
  const tool = tools.get(name);
  if (!tool) {
    return { name, missing: true };
  }
  return tool;
}

function builtInToolIds(profile: Profile): ToolId[] {
  const seen = new Set<ToolId>();
  if (profile.type === 'host' || profile.type === 'decision') {
    return [];
  }
  for (const binding of Object.values(profile.models)) {
    for (const id of binding.builtInTools ?? []) {
      seen.add(id);
    }
  }
  return [...seen];
}

function projectTools(
  tools: ToolRegistry,
  profile: Profile,
): Array<RegisteredTool | { name: ToolId; missing: true }> {
  const ids = [...profileToolAllow(profile), ...builtInToolIds(profile)];
  return ids.map((name) => projectTool(tools, name));
}

/** Adds the name of every property `schema`, a JSON Schema, declares at any depth. */
function addParams(schema: unknown, params: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const each of schema) addParams(each, params);
    return;
  }
  if (schema === null || typeof schema !== 'object') return;
  const { properties, ...rest } = schema as Record<string, unknown>;
  if (properties !== null && typeof properties === 'object') {
    for (const [name, property] of Object.entries(properties)) {
      params.add(name);
      addParams(property, params);
    }
  }
  for (const each of Object.values(rest)) addParams(each, params);
}

/** The names of the profile's tools and of their parameters (`GuardrailContext.ownTools`). */
function ownToolsOf(tools: ToolRegistry, profile: Profile): OwnTools | undefined {
  const projected = projectTools(tools, profile);
  if (projected.length === 0) return undefined;
  const params = new Set<string>();
  for (const tool of projected) if ('inputSchema' in tool) addParams(tool.inputSchema, params);
  return { names: projected.map(({ name }) => name), params: [...params] };
}

export { ownToolsOf, projectTools };
