import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { StageResult } from '../../src/kernel/stages.ts';
import { keptReply } from '../../src/kernel/turn-events.ts';
import type {
  ModelRequest,
  TurnEvent,
  TurnHistoryMessage,
  TurnModel,
} from '../../src/kernel/types.ts';
import { eventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';
import { replyText } from '../fixtures/reply.ts';

/** The reply a host keeps once the turn is over. */
function keptText(events: readonly TurnEvent[]): string {
  return replyText(keptReply(events));
}

/** The history messages the model reads, as role and text. */
function said(history: readonly TurnHistoryMessage[] | undefined): [string, string | null][] {
  return (history ?? []).slice(1).map((m) => [m.role, m.content ?? null]);
}

/**
 * A two-call turn that answers, takes a before_end inject carrying `released`, and answers again.
 * Returns the events and the history the second call read.
 */
async function answerTwice(id: string, inject: StageResult) {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
  let call = 0;
  let read: TurnHistoryMessage[] | undefined;
  const provider: TurnModel = {
    complete: async function* (req: ModelRequest) {
      call++;
      if (call === 2) read = req.history;
      yield { type: 'text', text: call === 1 ? 'first reply' : 'second reply' };
      yield { type: 'done', stop: { kind: 'completed' } };
    },
  };
  let injected = false;
  const events = await Array.fromAsync(
    runTurn(
      {
        profile: id,
        input: { text: 'hi' },
        onStage: ({ stage }) => {
          if (stage !== 'before_end' || injected) return;
          injected = true;
          return inject;
        },
      },
      provider,
    ),
  );
  return { events, read, call };
}

const steer = { role: 'user', content: 'and the fern?' } as const;

Deno.test('released: a before_end inject drops the draft the user does not have', async () => {
  const { events, read } = await answerTwice('released.before_end.drop', {
    inject: [steer],
    injectId: 'in-1',
    released: 0,
  });
  // The model reads the inject without the draft, and answers both from there.
  assertEquals(said(read), [['user', 'and the fern?']]);
  assertEquals(
    eventsOf(events, 'stage').filter((e) => e.released !== undefined),
    [{ type: 'stage', stage: 'before_end', injected: [{ id: 'in-1' }], released: 0 }],
  );
  assertEquals(replyText(events), 'first replysecond reply');
  assertEquals(keptText(events), 'second reply');
});

Deno.test('released: the part the user has stays, and the rest drops', async () => {
  const { events, read } = await answerTwice('released.before_end.part', {
    inject: [steer],
    injectId: 'in-2',
    released: 5,
  });
  assertEquals(said(read), [
    ['assistant', 'first'],
    ['user', 'and the fern?'],
  ]);
  assertEquals(keptText(events), 'first\n\nsecond reply');
});

Deno.test('released: a draft the user has in full stays', async () => {
  const { events, read } = await answerTwice('released.before_end.all', {
    inject: [steer],
    injectId: 'in-3',
    released: 'first reply'.length,
  });
  assertEquals(said(read), [
    ['assistant', 'first reply'],
    ['user', 'and the fern?'],
  ]);
  assertEquals(
    eventsOf(events, 'stage').some((e) => e.released !== undefined),
    false,
  );
  assertEquals(keptText(events), 'first reply\n\nsecond reply');
});

Deno.test('released: a count that is not a whole number warns, and the inject lands with nothing dropped', async () => {
  const { events, read } = await answerTwice('released.before_end.invalid', {
    inject: [steer],
    injectId: 'in-4',
    released: -1,
  });
  assertEquals(said(read), [
    ['assistant', 'first reply'],
    ['user', 'and the fern?'],
  ]);
  assertEquals(
    eventsOf(events, 'stage').some((e) =>
      (e.stageWarnings ?? []).some((w) => w.code === 'inject_released_invalid'),
    ),
    true,
  );
  assertEquals(keptText(events), 'first reply\n\nsecond reply');
});

Deno.test('released: a post_tool inject drops the text a step wrote before its calls', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'released.post_tool.drop',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 3,
      tools: { allow: ['stub_tool'] },
      inputs: { text: true },
    }),
  );
  let call = 0;
  let read: TurnHistoryMessage[] | undefined;
  const provider: TurnModel = {
    complete: async function* (req: ModelRequest) {
      call++;
      if (call === 1) {
        yield { type: 'text', text: 'Let me check.' };
        yield { type: 'tool', tool: { name: 'stub_tool', arguments: { value: 1 }, callId: 'c1' } };
        yield { type: 'done', stop: { kind: 'tool' } };
        return;
      }
      read = req.history;
      yield { type: 'text', text: 'Done.' };
      yield { type: 'done', stop: { kind: 'completed' } };
    },
  };
  const events = await Array.fromAsync(
    runTurn(
      {
        profile: 'released.post_tool.drop',
        input: { text: 'run tool' },
        onStage: ({ stage }) =>
          stage === 'post_tool' ? { inject: [steer], injectId: 'in-5', released: 0 } : undefined,
      },
      provider,
    ),
  );
  // The call and its result stay; only the unsent words before them leave.
  assertEquals(
    read?.slice(1).map((m) => [m.role, m.content ?? null, m.tool_calls?.length ?? 0]),
    [
      ['assistant', null, 1],
      ['tool', read?.[2]?.content ?? null, 0],
      ['user', 'and the fern?', 0],
    ],
  );
  assertEquals(keptText(events), 'Done.');
});
