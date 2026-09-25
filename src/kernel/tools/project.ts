/**
 * Tool projection for host/UI inspection.
 *
 * @module
 */

import type { Profile, ToolId } from '../types.ts';
import { getTool } from './registry.ts';
import { profileToolAllow } from './resolve.ts';
import type { RegisteredTool } from './types.ts';

function projectTool(name: ToolId): RegisteredTool | { name: ToolId; missing: true } {
  const tool = getTool(name);
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

function projectTools(profile: Profile): Array<RegisteredTool | { name: ToolId; missing: true }> {
  const ids = [...profileToolAllow(profile), ...builtInToolIds(profile)];
  return ids.map((name) => projectTool(name));
}

export { projectTools };
