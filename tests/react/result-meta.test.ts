import { assertEquals } from '@std/assert';
import type { LabelText } from '../../react/src/ui/labels.ts';
import { resultMeta } from '../../react/src/ui/labels.ts';

const t = ((key: string, values?: Record<string, unknown>) =>
  `${key}${values ? JSON.stringify(values) : ''}`) as LabelText;
const usd = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' });
const tokens = (count: number) => `${count} tokens`;

Deno.test("a console result's line holds what it has, in order, and leaves out the rest", () => {
  assertEquals(resultMeta(t, usd, { model: 'm', tokens }), 'm');
  assertEquals(
    resultMeta(t, usd, {
      model: 'm',
      elapsedMs: 250,
      usage: { inputTokens: 12, costUsd: 0.5 },
      tokens,
    }),
    'm · @theorem.duration.milliseconds{"ms":250} · 12 tokens · $0.50',
  );
  assertEquals(
    resultMeta(t, usd, { model: 'm', elapsedMs: null, usage: { costUsd: 0 }, tokens }),
    'm · $0.00',
  );
});
