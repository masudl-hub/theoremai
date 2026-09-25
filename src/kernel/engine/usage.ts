/**
 * One builder for `TurnTokens`, shared by every provider's usage reader.
 *
 * Each reader maps its provider's fields to the OpenTelemetry GenAI meanings
 * first (input = everything read, output = everything written); this module
 * fixes the shape: `total = input + output`, zero shares omitted, and a side
 * the provider left out marked `estimated` for the runner to fill.
 * `sumTokens` is the one way to total calls (a turn, a session, a range).
 *
 * @module
 */

import type { TurnCost, TurnGroundingCount, TurnTokenSide, TurnTokens } from '../types.ts';

/** Provider usage already mapped to the OpenTelemetry GenAI meanings. */
export interface ReportedUsage {
  /** Everything the model read. `undefined` = not reported. */
  input?: number;
  /** Everything the model wrote, reasoning included. `undefined` = not reported. */
  output?: number;
  thinking?: number;
  toolUse?: number;
  cached?: number;
  cacheWrite?: number;
  cost?: TurnCost;
  byModality?: TurnTokens['byModality'];
  grounding?: TurnGroundingCount[];
}

/** A non-negative finite number, else `undefined`. */
export function usageCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * `TurnTokens` from reported usage, or `undefined` when the provider reported
 * nothing. A missing side is 0 and listed in `estimated`. Input 0 counts as
 * missing, since every model call reads a prompt; an all-zero row (a
 * placeholder some servers stream) reports nothing.
 */
export function reportedTokens(usage: ReportedUsage): TurnTokens | undefined {
  const reportedInput = usage.input ? usage.input : undefined;
  if (reportedInput === undefined && !usage.output) return undefined;
  const estimated: TurnTokenSide[] = [];
  if (reportedInput === undefined) estimated.push('input');
  if (usage.output === undefined) estimated.push('output');
  const input = reportedInput ?? 0;
  const output = usage.output ?? 0;
  return {
    input,
    output,
    ...(usage.thinking ? { thinking: usage.thinking } : {}),
    ...(usage.toolUse ? { toolUse: usage.toolUse } : {}),
    ...(usage.cached ? { cached: usage.cached } : {}),
    ...(usage.cacheWrite ? { cacheWrite: usage.cacheWrite } : {}),
    total: input + output,
    ...(usage.cost ? { cost: usage.cost } : {}),
    ...(estimated.length > 0 ? { estimated } : {}),
    ...(usage.byModality ? { byModality: usage.byModality } : {}),
    ...(usage.grounding ? { grounding: usage.grounding } : {}),
  };
}

function sumCost(calls: TurnTokens[]): TurnCost | undefined {
  const costs = calls.flatMap((call) => (call.cost ? [call.cost] : []));
  if (costs.length === 0) return undefined;
  const upstream = costs.flatMap((cost) =>
    cost.upstreamUsd === undefined ? [] : [cost.upstreamUsd],
  );
  const partial = costs.length < calls.length || costs.some((cost) => cost.partial);
  return {
    usd: costs.reduce((sum, cost) => sum + cost.usd, 0),
    ...(upstream.length > 0 ? { upstreamUsd: upstream.reduce((sum, usd) => sum + usd, 0) } : {}),
    ...(partial ? { partial: true } : {}),
  };
}

/**
 * A modality's share summed across calls, kept only when every call reported
 * that modality: a partial sum would read as exact and be wrong.
 */
function sumByModality(calls: TurnTokens[]): TurnTokens['byModality'] {
  const sides: TurnTokenSide[] = ['input', 'output'];
  const summed: NonNullable<TurnTokens['byModality']> = {};
  for (const side of sides) {
    const [first, ...rest] = calls.map((call) => call.byModality?.[side]);
    const modalities = Object.keys(first ?? {}).filter((modality) =>
      rest.every((counts) => counts?.[modality] !== undefined),
    );
    if (modalities.length === 0) continue;
    summed[side] = Object.fromEntries(
      modalities.map((modality) => [
        modality,
        calls.reduce((sum, call) => sum + (call.byModality?.[side]?.[modality] ?? 0), 0),
      ]),
    );
  }
  return Object.keys(summed).length > 0 ? summed : undefined;
}

/**
 * Grounding use summed per tool over the calls that reported it; a call that
 * ran no grounding tool reports none. `searchQueryCount` sums only when every
 * report of that tool carried it.
 */
function sumGrounding(calls: TurnTokens[]): TurnGroundingCount[] | undefined {
  const byType = new Map<string, TurnGroundingCount[]>();
  for (const entry of calls.flatMap((call) => call.grounding ?? [])) {
    byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry]);
  }
  if (byType.size === 0) return undefined;
  return [...byType].map(([type, entries]) => {
    const queries = entries.every((entry) => entry.searchQueryCount !== undefined);
    return {
      type,
      count: entries.reduce((sum, entry) => sum + entry.count, 0),
      ...(queries
        ? {
            searchQueryCount: entries.reduce(
              (sum, entry) => sum + (entry.searchQueryCount ?? 0),
              0,
            ),
          }
        : {}),
    };
  });
}

/**
 * Total of several calls' `TurnTokens`, or `undefined` for none. Counts and
 * shares add up. A side is `estimated` when any call estimated it, so shares
 * of that side cover only what providers reported. `unknownMedia` adds up per
 * side. Cost adds up over the calls that reported one and is `partial` when
 * some did not; `upstreamUsd` adds up where reported (OpenRouter reports it
 * only for BYOK, so its absence is not missing data). Per-modality shares and
 * grounding follow `sumByModality` and `sumGrounding`.
 */
export function sumTokens(calls: TurnTokens[]): TurnTokens | undefined {
  if (calls.length === 0) return undefined;
  const add = (pick: (call: TurnTokens) => number | undefined): number =>
    calls.reduce((sum, call) => sum + (pick(call) ?? 0), 0);
  const input = add((call) => call.input);
  const output = add((call) => call.output);
  const thinking = add((call) => call.thinking);
  const toolUse = add((call) => call.toolUse);
  const cached = add((call) => call.cached);
  const cacheWrite = add((call) => call.cacheWrite);
  const cost = sumCost(calls);
  const byModality = sumByModality(calls);
  const grounding = sumGrounding(calls);
  const sides: TurnTokenSide[] = ['input', 'output'];
  const estimated = sides.filter((side) => calls.some((call) => call.estimated?.includes(side)));
  const unknownMedia: Partial<Record<TurnTokenSide, number>> = {};
  for (const side of sides) {
    const count = add((call) => call.unknownMedia?.[side]);
    if (count > 0) unknownMedia[side] = count;
  }
  return {
    input,
    output,
    ...(thinking ? { thinking } : {}),
    ...(toolUse ? { toolUse } : {}),
    ...(cached ? { cached } : {}),
    ...(cacheWrite ? { cacheWrite } : {}),
    total: input + output,
    ...(cost ? { cost } : {}),
    ...(estimated.length > 0 ? { estimated } : {}),
    ...(Object.keys(unknownMedia).length > 0 ? { unknownMedia } : {}),
    ...(byModality ? { byModality } : {}),
    ...(grounding ? { grounding } : {}),
  };
}
