import '../fixtures/test-host.ts';
import { assertEquals } from '@std/assert';
import { createCliTraceCapture, printTraceRecord } from '../../src/cli/event-log.ts';
import { forClient } from '../../src/host/client-turn.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';

Deno.test('createCliTraceCapture records turns and supports jsonl mirror', async () => {
  const dir = await Deno.makeTempDir();
  const capture = createCliTraceCapture(dir);
  const provider: ModelProvider = {
    async *complete() {
      yield { type: 'text', text: 'ok' };
      yield { type: 'done' };
    },
  };

  for await (const _ of runTurn(
    { profile: 'chat', input: { text: 'hi' } },
    provider,
    capture.sink,
  )) {
    // drain
  }

  assertEquals(capture.records.length, 1);
  assertEquals(capture.records[0]?.ok, true);

  const files = [];
  for await (const entry of Deno.readDir(dir)) {
    files.push(entry.name);
  }
  assertEquals(
    files.some((name) => name.startsWith('turns-') && name.endsWith('.jsonl')),
    true,
  );
});

Deno.test('printTraceRecord warns when no record captured', () => {
  let logged = '';
  const original = console.error;
  console.error = (msg: string) => {
    logged = msg;
  };
  try {
    printTraceRecord(undefined, false);
  } finally {
    console.error = original;
  }
  assertEquals(logged.includes('[trace]'), true);
});

Deno.test('forClient and CLI verbose paths preserve complementary fields', () => {
  const event: TurnEvent = {
    type: 'error',
    error: 'Unavailable',
    errorInternal: 'Gemini HTTP 503',
  };
  const client = forClient(event);
  assertEquals(client.error, 'Unavailable');
  assertEquals(client.errorInternal, undefined);
});
