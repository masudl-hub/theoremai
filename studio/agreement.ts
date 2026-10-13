/**
 * Whether a profile the studio opened is the profile the project registered. The studio reads a
 * profile into its own draft and compiles it back; the two may differ only in the settings the
 * studio's policy sets for itself, and any other difference is one the studio has to show.
 *
 * @module
 */

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
 * Each setting `studio` holds differently from `project`, by its path. Nothing is taken as equal
 * but the same value: a default written out and a setting left out are two things here, because
 * what a setting left out means is the kernel's to say.
 */
export function differingSettings(project: unknown, studio: unknown): string[] {
  const found: string[] = [];
  const walk = (ours: unknown, theirs: unknown, path: string[]) => {
    if (JSON.stringify(ours) === JSON.stringify(theirs) || isPolicy(path)) return;
    if (!isRecord(ours) || !isRecord(theirs)) {
      found.push(path.join('.'));
      return;
    }
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) walk(ours[key], theirs[key], [...path, key]);
  };
  walk(project, studio, []);
  return found;
}
