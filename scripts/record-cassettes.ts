#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-sys

/**
 * Records the cassettes tests/cassettes/replay.test.ts replays. Each recording
 * is replayed at once and kept only when it replays to the same outcome.
 *
 *   deno task cassettes:record [--model <apiId>,…] [--only <text>] [--missing] [--stale]
 *   deno task cassettes:update [--model <apiId>,…] [--only <text>]
 *
 * `--missing` records only cases with no cassette; `--stale` only those whose
 * replay no longer matches what Theorem sends. `--update` calls nothing: it
 * replays every cassette and keeps the outcome it now produces, for a change
 * meant to alter what a turn does.
 */

import {
  CASSETTE_MODELS,
  type CassetteCase,
  type CassetteModel,
  casesFor,
} from '../tests/cassettes/cases.ts';
import { readCassette, recordCase, replayCase, writeCassette } from '../tests/cassettes/tape.ts';
import { hostOpenRouterKey, hostVault, loadHostEnv } from './host-env.ts';

/** Free-key requests per minute allow one call every four seconds. */
const PACE_MS = 4100;

function flag(name: string): string | undefined {
  const at = Deno.args.indexOf(name);
  return at === -1 ? undefined : Deno.args[at + 1];
}

const update = Deno.args.includes('--update');
const missing = Deno.args.includes('--missing');
const stale = Deno.args.includes('--stale');
const only = flag('--only');
const named = flag('--model')?.split(',');
const unknown = named?.filter((id) => !CASSETTE_MODELS.some((m) => m.apiId === id));
if (unknown?.length) throw new Error(`no cassette model ${unknown.join(', ')}`);
const models = named ? CASSETTE_MODELS.filter((m) => named.includes(m.apiId)) : CASSETTE_MODELS;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function wanted(model: CassetteModel, c: CassetteCase): Promise<boolean> {
  if (only && !c.id.includes(only)) return false;
  if (!missing && !stale) return true;
  const cassette = await readCassette(model.apiId, c.id);
  if (!cassette) return missing;
  if (!stale) return false;
  const { drift } = await replayCase(cassette, c);
  return drift.stale.length > 0;
}

async function updateOutcomes(model: CassetteModel): Promise<void> {
  for (const c of casesFor(model)) {
    if (only && !c.id.includes(only)) continue;
    const cassette = await readCassette(model.apiId, c.id);
    if (!cassette) continue;
    const { run, drift } = await replayCase(cassette, c);
    if (drift.stale.length) {
      console.log(`${model.apiId} ${c.id} STALE, record it again: ${drift.stale[0]}`);
      continue;
    }
    if (JSON.stringify(run.outcome) === JSON.stringify(cassette.outcome)) continue;
    await writeCassette({ ...cassette, outcome: run.outcome });
    console.log(`${model.apiId} ${c.id} outcome updated`);
  }
}

async function record(model: CassetteModel): Promise<void> {
  const openrouter = hostOpenRouterKey();
  const vault = { ...hostVault(), ...(openrouter ? { openrouter } : {}) };
  const counts = { kept: 0, unserved: 0, unreplayable: 0, misses: 0 };
  for (const c of casesFor(model)) {
    if (!(await wanted(model, c))) continue;
    const started = performance.now();
    let recorded: Awaited<ReturnType<typeof recordCase>>;
    try {
      recorded = await recordCase(model, c, vault);
    } catch (err) {
      counts.unserved++;
      console.log(
        `${model.apiId} ${c.id} THREW ${err instanceof Error ? err.message : String(err)}`,
      );
      await sleep(PACE_MS);
      continue;
    }
    const { cassette, run, reply } = recorded;
    const ms = Math.round(performance.now() - started);
    if (!cassette) {
      counts.unserved++;
      console.log(`${model.apiId} ${c.id} UNSERVED ${run.outcome.error} ${ms} ms ${reply ?? ''}`);
    } else {
      const replay = await replayCase(cassette, c);
      const same = JSON.stringify(replay.run.outcome) === JSON.stringify(cassette.outcome);
      if (replay.drift.stale.length || !same) {
        counts.unreplayable++;
        console.log(
          `${model.apiId} ${c.id} UNREPLAYABLE ${replay.drift.stale[0] ?? 'outcome differs on replay'}`,
        );
      } else {
        await writeCassette(cassette);
        counts.kept++;
        if (run.misses.length) counts.misses++;
        console.log(
          `${model.apiId} ${c.id} ${run.misses.length ? `MISS ${run.misses.join('; ')}` : 'ok'} ` +
            `${cassette.outcome.guardrails.join(', ')} ${ms} ms`,
        );
      }
    }
    await sleep(PACE_MS);
  }
  console.log(`${model.apiId}: ${JSON.stringify(counts)}`);
}

if (update) {
  for (const model of models) await updateOutcomes(model);
} else {
  loadHostEnv();
  for (const model of models) await record(model);
}
