/**
 * Trace failure honesty — no test-host fixture (profile registry independent).
 */
import { sanitizeTurnRequestForTrace } from '../../src/guardrails/sanitize.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { writeTrace } from '../../src/observability/trace.ts';
import { buildRecord, type TraceRecord } from '../../src/observability/trace-record.ts';

function stubRecord(): TraceRecord {
  return {
    v: 1,
    id: 'x',
    ts: 1,
    ms: 1,
    streamed: true,
    cancelled: false,
    previousInteractionId: null,
    store: false,
    profile: 'chat',
    input: { attachments: [], voice: [] },
    events: [],
    ok: true,
  };
}

Deno.test('sanitizeTurnRequestForTrace keeps text when blob sanitize throws', () => {
  const traced = sanitizeTurnRequestForTrace({
    profile: 'no-such-profile-for-trace',
    input: {
      text: 'keep this prompt',
      attachments: [{ mimeType: 'image/png', data: 'YWJj' }],
    },
  });
  assertEquals(traced.request.input?.text, 'keep this prompt');
  assertEquals(traced.request.input?.attachments?.length, 1);
  assertEquals(typeof traced.sanitizeError, 'string');
  assertEquals(traced.sanitizeError?.includes('Unknown profile'), true);
});

Deno.test('buildRecord never invents empty input when request sanitize fails', async () => {
  const rec = await buildRecord({
    req: {
      profile: 'no-such-profile-for-trace',
      input: {
        text: 'user said this',
        attachments: [{ mimeType: 'image/png', data: 'YWJj' }],
      },
    },
    events: [],
    started: Date.now(),
  });
  assertEquals(rec.input.text, 'user said this');
  assertEquals(rec.input.attachments.length, 1);
  assertEquals(rec.input.attachments[0]?.mimeType, 'image/png');
  assertEquals(typeof rec.input.attachments[0]?.sha256, 'string');
  assertEquals(String(rec.errorInternal).includes('request sanitize for trace failed'), true);
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
  );
});
