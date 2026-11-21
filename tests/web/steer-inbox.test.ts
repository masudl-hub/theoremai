import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../mod.ts';
import {
  createMemorySteerInbox,
  steerStage,
  steerUnitOf,
  theoremSteerRequestSchema,
} from '../../web/src/server/mod.ts';

Deno.test('a steer body keeps the trimmed id, and its unit is one user message', () => {
  const body = theoremSteerRequestSchema.parse({
    turnId: ' turn-1 ',
    id: ' steer-1 ',
    input: { text: 'steered' },
  });
  assertEquals('turnId' in body ? body.turnId : undefined, 'turn-1');
  assertEquals(steerUnitOf(body), {
    id: 'steer-1',
    messages: [{ role: 'user', content: 'steered' }],
  });
});

Deno.test("a steer's files go to the model beside its text", () => {
  const photo = { name: 'leaf.png', mimeType: 'image/png', data: 'aGk=' };
  assertEquals(steerUnitOf({ id: 'steer-1', input: { text: 'this one', attachments: [photo] } }), {
    id: 'steer-1',
    messages: [
      {
        role: 'user',
        parts: [
          { type: 'image', mimeType: 'image/png', data: 'aGk=' },
          { type: 'text', text: 'this one' },
        ],
      },
    ],
  });
});

Deno.test('a steer without a turn or a conversation, an id, or a message fails its check', () => {
  const input = { text: 'steered' };
  // Each body fails both forms: to a turn by its id, and to the reply that holds a conversation.
  // A body that only one form could have been fails with that form's reason alone.
  const refused: [unknown, string[]][] = [
    [{ turnId: 't', input }, ['id', 'id']],
    [{ turnId: 't', id: '  ', input }, ['id']],
    [{ turnId: 't', id: 7, input }, ['id', 'id']],
    [{ id: 'steer-1', input }, ['turnId', 'conversation']],
    [{ turnId: 't', id: 'steer-1' }, ['input', 'input']],
    [{ turnId: 't', id: 'steer-1', input: 'steered' }, ['input', 'input']],
  ];
  for (const [body, paths] of refused) {
    const parsed = theoremSteerRequestSchema.safeParse(body);
    assertEquals(parsed.success, false);
    if (parsed.success) continue;
    const [issue] = parsed.error.issues;
    const reasons =
      issue?.code === 'invalid_union'
        ? issue.errors.map((form) => form[0]?.path[0])
        : [issue?.path[0]];
    assertEquals(reasons, paths);
  }
});

Deno.test('a steer with no text and no file is refused', () => {
  assertThrows(
    () => steerUnitOf({ id: 'steer-1', input: { text: '  ' } }),
    TheoremError,
    'a steer needs text or a file',
  );
});

Deno.test('steerStage lands one steer per steerable stage, named by its id', async () => {
  const inbox = createMemorySteerInbox();
  inbox.open('turn');
  inbox.enqueue('turn', { id: 'steer-1', messages: [{ role: 'user', content: 'first' }] });
  inbox.enqueue('turn', { id: 'steer-2', messages: [{ role: 'user', content: 'second' }] });
  const stage = steerStage(inbox, 'turn');

  assertEquals(await stage({ stage: 'post_turn', step: 0, history: [] }), undefined);
  assertEquals(await stage({ stage: 'pre_turn', step: 0, history: [] }), {
    inject: [{ role: 'user', content: 'first' }],
    injectId: 'steer-1',
  });
  assertEquals(await stage({ stage: 'before_end', step: 0, history: [] }), {
    inject: [{ role: 'user', content: 'second' }],
    injectId: 'steer-2',
  });
  assertEquals(await stage({ stage: 'post_tool', step: 0, history: [] }), undefined);
});

Deno.test('a stop reaches the open turn, even one that asks after it came', async () => {
  const inbox = createMemorySteerInbox();
  assertEquals(await inbox.stop('turn-1'), false);
  assertEquals(await inbox.stopped('turn-1'), false);
  inbox.open('turn-1');
  const waiting = inbox.stopped('turn-1');
  assertEquals(await inbox.stop('turn-1'), true);
  assertEquals(await waiting, true);
  assertEquals(await inbox.stopped('turn-1'), true);
  inbox.open('turn-2');
  const closed = inbox.stopped('turn-2');
  inbox.close('turn-2');
  assertEquals(await closed, false);
  assertEquals(await inbox.stop('turn-2'), false);
});
