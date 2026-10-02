/**
 * Record a case against the real provider, or replay it from its cassette.
 */

import type { KeyVault } from '../../src/kernel/types.ts';
import {
  type Cassette,
  type LiveFrame,
  type RecordedExchange,
  type ReplayDrift,
  recordDraws,
  recordingFetch,
  recordingSocket,
  replayDraws,
  replayFetch,
  replaySocket,
} from '../fixtures/cassette.ts';
import type { CaseRun, CassetteCase, CassetteModel } from './cases.ts';
import { modelSlug } from './cases.ts';

export const CASSETTE_ROOT = new URL('./recorded/', import.meta.url);

export function cassetteUrl(model: string, caseId: string): URL {
  return new URL(`${modelSlug(model)}/${caseId}.json`, CASSETTE_ROOT);
}

/** Run `c` on the real provider; no cassette when the provider did not serve it, and its last reply. */
export async function recordCase(
  model: CassetteModel,
  c: CassetteCase,
  vault: KeyVault,
): Promise<{ cassette?: Cassette; run: CaseRun; reply?: string }> {
  const exchanges: RecordedExchange[] = [];
  const frames: LiveFrame[] = [];
  const draws: string[] = [];
  const http = recordingFetch(exchanges);
  const socket = recordingSocket(frames);
  const run = await recordDraws(draws, () =>
    c.run({ vault, fetch: http.fetch, openWebSocket: socket.openWebSocket }, draws),
  );
  await http.drained();
  await socket.drained();
  if (run.unserved) {
    const last = exchanges.at(-1);
    return {
      run,
      ...(last ? { reply: `${last.status} ${last.chunks.join('').slice(-400)}` } : {}),
    };
  }
  return {
    run,
    cassette: {
      model: model.apiId,
      case: c.id,
      draws,
      exchanges,
      ...(frames.length ? { frames } : {}),
      outcome: run.outcome,
    },
  };
}

/** Keys a replay hands the adapters; nothing leaves the process. */
const REPLAY_VAULT: KeyVault = { slot_a: 'replay', openrouter: 'replay' };

/** Run `c` against its recording. */
export async function replayCase(
  cassette: Cassette,
  c: CassetteCase,
): Promise<{ run: CaseRun; drift: ReplayDrift }> {
  const drift: ReplayDrift = { stale: [] };
  const run = await replayDraws(cassette.draws, drift, () =>
    c.run(
      {
        vault: REPLAY_VAULT,
        fetch: replayFetch(cassette.exchanges, drift),
        openWebSocket: replaySocket(cassette.frames ?? [], drift),
      },
      cassette.draws,
    ),
  );
  return { run, drift };
}

export async function readCassette(model: string, caseId: string): Promise<Cassette | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(cassetteUrl(model, caseId)));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

export async function writeCassette(cassette: Cassette): Promise<void> {
  const url = cassetteUrl(cassette.model, cassette.case);
  await Deno.mkdir(new URL('./', url), { recursive: true });
  await Deno.writeTextFile(url, `${JSON.stringify(cassette, null, 1)}\n`);
}
