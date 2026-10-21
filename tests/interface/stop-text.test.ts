import { assertEquals } from '@std/assert';
import { CLIENT_LABEL_KEYS, clientLabels } from '../../src/guardrails/labels.ts';
import { stopText, type TranscriptBlock, WORDED_STOP_KINDS } from '../../src/interface/mod.ts';

const REPLY: TranscriptBlock[] = [{ id: 'a', kind: 'text', text: 'Once upon' }];

Deno.test('a turn that ended short says why in its stop label', () => {
  assertEquals(stopText({ kind: 'length' }, REPLY), 'cut off at the length limit');
  assertEquals(stopText({ kind: 'cancelled' }, []), 'interrupted');
});

Deno.test('a whole turn, or one an error already explains, has no stop text', () => {
  assertEquals(stopText({ kind: 'completed' }, REPLY), undefined);
  assertEquals(stopText({ kind: 'tool' }, REPLY), undefined);
  assertEquals(stopText(undefined, REPLY), undefined);
  const failed: TranscriptBlock[] = [
    ...REPLY,
    { id: 'e', kind: 'error', message: 'Sorry, the model is unavailable.' },
  ];
  assertEquals(stopText({ kind: 'provider_error' }, failed), undefined);
});

Deno.test("a reply Theorem's guardrail stopped is not called a content filter", () => {
  const refused: TranscriptBlock[] = [
    { id: 'r', kind: 'text', text: "Sorry, that reply couldn't be shared." },
  ];
  for (const native of ['egress', 'canary', 'prompt_echo', 'provider_tool_leak']) {
    assertEquals(stopText({ kind: 'filtered', native }, refused), undefined, native);
  }
  assertEquals(
    stopText({ kind: 'filtered', native: 'SAFETY' }, REPLY),
    'stopped by a content filter',
  );
});

Deno.test("a profile's stop and picker wording reaches the client and is used", () => {
  for (const kind of WORDED_STOP_KINDS) {
    assertEquals(CLIENT_LABEL_KEYS.includes(`stop.${kind}`), true, kind);
  }
  const labels = clientLabels({
    'stop.stream_incomplete': 'Connection lost mid-generation',
    'composer.model': 'Brain',
  });
  assertEquals(labels['composer.model'], 'Brain');
  assertEquals(
    stopText({ kind: 'stream_incomplete' }, REPLY, labels),
    'Connection lost mid-generation',
  );
});
