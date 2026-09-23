/**
 * Trace failure honesty — no test-host fixture (profile registry independent).
 */
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { resolveObservabilityPolicy } from '../../src/observability/resolve-policy.ts';
import { memorySink, writeTrace } from '../../src/observability/trace.ts';
import { contentOf, type TraceRecord } from '../../src/observability/trace-record.ts';
import type { TraceAttributes } from '../../src/observability/trace-span.ts';
import { stubRecord } from '../fixtures/trace-record.ts';

Deno.test('a turn that fails before the model still records its raw input and why', async () => {
  const into: TraceRecord[] = [];
  let thrown: unknown;
  try {
    for await (const _ of runTurn(
      {
        profile: 'no-such-profile-for-trace',
        input: { text: 'user said this', attachments: [{ mimeType: 'image/png', data: 'YWJj' }] },
      },
      { complete: async function* () {} },
      memorySink(into),
    )) {
      // drain
    }
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof Error, true);
  const [record] = into;
  const root = record?.spans[0];
  const [message] = (root?.attributes['gen_ai.input.messages'] ?? []) as {
    parts: TraceAttributes[];
  }[];
  const [text, image] = message?.parts ?? [];
  assertEquals(record && contentOf(record, text), 'user said this');
  assertEquals(image?.mime_type, 'image/png');
  assertEquals(typeof image?.content_sha256, 'string');
  assertEquals(root?.status.code, 'ERROR');
  assertEquals(
    root?.events.some((e) => e.name === 'exception'),
    true,
  );
});

Deno.test('writeTrace reports sink failures via onError without throwing', async () => {
  const seen: unknown[] = [];
  await writeTrace(
    {
      write: () => Promise.reject(new Error('Disk full')),
      onError: (err) => {
        seen.push(err);
      },
    },
    Promise.resolve(stubRecord()),
    resolveObservabilityPolicy(undefined),
  );
  assertEquals(seen.length, 1);
  assertEquals(seen[0] instanceof Error && (seen[0] as Error).message, 'Disk full');
});

Deno.test('writeTrace reports record-build failures via onError without throwing', async () => {
  const seen: unknown[] = [];
  await writeTrace(
    {
      write: () => Promise.resolve(),
      onError: (err) => {
        seen.push(err);
      },
    },
    Promise.reject(new Error('build blew up')),
    resolveObservabilityPolicy(undefined),
  );
  assertEquals(seen.length, 1);
  assertEquals(seen[0] instanceof Error && (seen[0] as Error).message, 'build blew up');
});

Deno.test('writeTrace ignores onError throws so the turn stays alive', async () => {
  await writeTrace(
    {
      write: () => Promise.reject(new Error('Disk full')),
      onError: () => {
        throw new Error('host logger crashed');
      },
    },
    Promise.resolve(stubRecord()),
    resolveObservabilityPolicy(undefined),
  );
});
