import { assertEquals } from '@std/assert';
import type { DecisionResult, StageContext } from '@theoremjs/agents';
import type { ToolRegistration } from '../../studio/registrations.ts';
import {
  bothStages,
  type ReadPassage,
  type ToolReader,
  toolReaderStage,
  toolReaders,
} from '../../studio/tool-readers.ts';

const reader: ToolReader = {
  profile: 'reader',
  questions: {
    passage: {
      type: 'choice',
      instructions: 'Does it bear on the question?',
      criteria: { relevant: 'It does.', not_relevant: 'It does not.' },
    },
  },
};

const pick = (choice: string): DecisionResult => ({
  model: 'jev',
  answers: { passage: { type: 'choice', choice, confidence: 1, probabilities: {} } },
});

const keepsAbout =
  (word: string): ReadPassage =>
  (_, { passage }) =>
    Promise.resolve(pick(passage.includes(word) ? 'relevant' : 'not_relevant'));

const finished: StageContext = {
  stage: 'post_tool',
  step: 1,
  history: [],
  tool: 'read_pages',
  input: { question: 'What about memory?' },
  outputRaw: 'memory one\n\nnavigation\n\n  \n\nmemory two',
};

const stage = (read: ReadPassage) => toolReaderStage(new Map([['read_pages', reader]]), read);

Deno.test('a reader keeps the passages on the first choice', async () => {
  const asked: unknown[] = [];
  const read: ReadPassage = (_, state) => {
    asked.push(state);
    return keepsAbout('memory')(reader, state);
  };
  assertEquals(await stage(read)(finished), { mutate: { output: 'memory one\n\nmemory two' } });
  assertEquals(asked[1], { question: 'What about memory?', passage: 'navigation' });
});

Deno.test('a reader that keeps every passage changes nothing', async () => {
  const read: ReadPassage = () => Promise.resolve(pick('relevant'));
  assertEquals(await stage(read)(finished), undefined);
});

Deno.test('a reader that fails leaves the output whole', async () => {
  const read: ReadPassage = () => Promise.reject(new Error('no key'));
  assertEquals(await stage(read)(finished), undefined);
});

Deno.test('a reader runs only on a finished string output of its tool, with a question', async () => {
  const read: ReadPassage = () => {
    throw new Error('it should not run');
  };
  for (const ctx of [
    { ...finished, stage: 'pre_tool' as const },
    { ...finished, tool: 'other' },
    { ...finished, outputRaw: { text: 'memory' } },
    { ...finished, input: {} },
    { ...finished, awaiting: true },
    { ...finished, callNotStarted: true },
  ]) {
    assertEquals(await stage(read)(ctx), undefined);
  }
});

Deno.test('toolReaders reads the tools a run filled in', () => {
  const tool = {
    type: 'function',
    name: 'read_pages',
    stageAgent: 'reader',
    stageQuestions: reader.questions,
  } as ToolRegistration;
  const unfilled = { ...tool, name: 'other', stageQuestions: undefined } as ToolRegistration;
  assertEquals([...toolReaders([tool, unfilled]).entries()], [['read_pages', reader]]);
});

Deno.test('bothStages keeps what each handler asks', async () => {
  const inject = [{ role: 'user', content: 'steer' }] as never;
  const both = bothStages(
    () => Promise.resolve({ inject, injectId: 'a' }),
    () => Promise.resolve({ mutate: { output: 'cut' } }),
  );
  assertEquals(await both(finished), { inject, injectId: 'a', mutate: { output: 'cut' } });
  assertEquals(
    await bothStages(
      () => undefined,
      () => undefined,
    )(finished),
    undefined,
  );
});
