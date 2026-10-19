/**
 * Whether a profile the studio opened is the profile the project registered. The studio reads a
 * profile into its own draft and compiles it back; the two may differ only in the settings the
 * studio's policy sets for itself, and any other difference is one the studio has to show.
 *
 * @module
 */

import { type DetectSpec, resolveAllow, resolveDetect } from '@theoremjs/agents/guardrails';
import { unsetValue } from '@theoremjs/agents/kernel';
import { STUDIO_POLICY_UNSET } from './policy.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether the studio holds `theirs` at `path` only because the project left it out: its policy fills it in. */
function isPolicyFill(path: readonly string[], ours: unknown, theirs: unknown): boolean {
  return (
    ours === undefined && theirs !== undefined && STUDIO_POLICY_UNSET[path.join('.')] === theirs
  );
}

/** `held` without the table the kernel works out from its patterns. */
const uncompiled = <T extends { compiled?: unknown }>({ compiled: _, ...held }: T) => held;

/**
 * What the kernel reads `detect` as: each detector's action at each boundary, whose patterns it
 * reads with, and what it lets through. Two settings the kernel reads the same are the same here.
 */
function detectAsRead(detect: unknown): unknown {
  if (detect === undefined) return undefined;
  const { sources = {}, host = [], ...read } = resolveDetect(detect as DetectSpec);
  const allow = Object.entries(resolveAllow(detect as DetectSpec)).map(([detector, held]) => [
    detector,
    {
      ...held,
      fromTools:
        held.fromTools ?? unsetValue(['guardrails', 'detect', detector, 'allow', 'fromTools']),
    },
  ]);
  return {
    ...read,
    sources: Object.fromEntries(
      Object.entries(sources).map(([detector, source]) => [detector, uncompiled(source)]),
    ),
    host: Object.fromEntries(host.map(({ id, ...rule }) => [id, uncompiled(rule)])),
    allow: Object.fromEntries(allow),
  };
}

/** A profile with its `detect` as the kernel reads it. */
function asRead(profile: unknown): unknown {
  if (
    !isRecord(profile) ||
    !isRecord(profile.guardrails) ||
    profile.guardrails.detect === undefined
  )
    return profile;
  return {
    ...profile,
    guardrails: { ...profile.guardrails, detect: detectAsRead(profile.guardrails.detect) },
  };
}

/**
 * Each setting `studio` holds differently from `project`, by its path. A setting left out is the
 * value the kernel says leaving it out stands for, and where the kernel names no such value,
 * left out and written are two things. A section left out is one written with nothing in it: each
 * setting in it is then read as left out, and a difference is named where it is.
 */
export function differingSettings(project: unknown, studio: unknown): string[] {
  const found: string[] = [];
  const walk = (ours: unknown, theirs: unknown, path: string[]) => {
    if (isPolicyFill(path, ours, theirs)) return;
    let [mine, yours] = [ours ?? unsetValue(path), theirs ?? unsetValue(path)];
    if (mine === undefined && isRecord(yours)) mine = {};
    if (yours === undefined && isRecord(mine)) yours = {};
    if (JSON.stringify(mine) === JSON.stringify(yours)) return;
    if (!isRecord(mine) || !isRecord(yours)) {
      found.push(path.join('.'));
      return;
    }
    for (const key of new Set([...Object.keys(mine), ...Object.keys(yours)]))
      walk(mine[key], yours[key], [...path, key]);
  };
  walk(asRead(project), asRead(studio), []);
  return found;
}
