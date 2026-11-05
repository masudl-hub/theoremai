/**
 * Every recorded turn of one model replayed through the real adapters and
 * kernel, offline. Each model has a `replay.<model>.test.ts` of its own, so
 * `deno test --parallel` replays the models side by side.
 * A case fails on a guardrail miss or on an outcome other than the recorded
 * one. A request that differs from its recording (a prompt reworded) is
 * listed, not failed: the reply is still a real model's, and recording it
 * again costs a call per case, so `cassettes:record --stale` is run when wanted.
 */

import { assertEquals } from '@std/assert';
import { CASSETTE_MODELS, casesFor, normalizeOutcome } from './cases.ts';
import { readCassette, replayCase } from './tape.ts';

/** Registers the replay of every case recorded for the model `apiId`. */
export function replayModel(apiId: string): void {
  const model = CASSETTE_MODELS.find((each) => each.apiId === apiId);
  if (!model) throw new Error(`no cassette model ${apiId}`);
  Deno.test(`cassettes: ${model.apiId}`, async (t) => {
    const stale: string[] = [];
    for (const c of casesFor(model)) {
      const cassette = await readCassette(model.apiId, c.id);
      await t.step({
        name: cassette ? c.id : `${c.id} (not recorded)`,
        ignore: !cassette,
        async fn() {
          if (!cassette) return;
          const { run, drift } = await replayCase(cassette, c);
          if (drift.stale.length) stale.push(`${c.id}: ${drift.stale[0]}`);
          assertEquals(run.misses, [], 'guardrail misses');
          assertEquals(
            run.outcome,
            normalizeOutcome(cassette.outcome),
            `outcome changed; if meant, keep it with: deno task cassettes:update\n${drift.stale.join('\n')}`,
          );
        },
      });
    }
    if (stale.length) {
      console.warn(
        `${stale.length} ${model.apiId} cassettes replay requests Theorem no longer sends; ` +
          `refresh with: deno task cassettes:record --model ${model.apiId} --stale\n` +
          stale.slice(0, 3).join('\n'),
      );
    }
  });
}
