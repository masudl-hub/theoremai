/**
 * Whether a profile the studio opened is the profile the project registered. The studio reads a
 * profile into its own draft and compiles it back; the two may differ only in the settings the
 * studio's policy sets for itself, and any other difference is one the studio has to show.
 *
 * @module
 */

import { unsetValue } from '../src/kernel/profile-presence.ts';
import { STUDIO_POLICY_PATHS } from './policy.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether `path` is one the studio's policy sets: `*` stands for any one key. */
function isPolicy(path: readonly string[]): boolean {
  return STUDIO_POLICY_PATHS.some((held) => {
    const keys = held.split('.');
    return keys.length === path.length && keys.every((key, index) => key === '*' || key === path[index]);
  });
}

/**
 * Each setting `studio` holds differently from `project`, by its path. A setting left out is the
 * value the kernel says leaving it out stands for, and where the kernel names no such value,
 * left out and written are two things.
 */
export function differingSettings(project: unknown, studio: unknown): string[] {
  const found: string[] = [];
  const walk = (ours: unknown, theirs: unknown, path: string[]) => {
    if (isPolicy(path)) return;
    const [mine, yours] = [ours ?? unsetValue(path), theirs ?? unsetValue(path)];
    if (JSON.stringify(mine) === JSON.stringify(yours)) return;
    if (!isRecord(mine) || !isRecord(yours)) {
      found.push(path.join('.'));
      return;
    }
    for (const key of new Set([...Object.keys(mine), ...Object.keys(yours)])) walk(mine[key], yours[key], [...path, key]);
  };
  walk(project, studio, []);
  return found;
}
