import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';

registerFixtureProviders(defaultKernelScope);

import { assertEquals } from '@std/assert';
import { type DecisionQuestion, registerProfile, z } from '../../mod.ts';
import { compileWorkspace } from '../../studio/compile-workspace.ts';
import { newConversationKey } from '../../studio/conversation-key.ts';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import { createDecisionExampleDraft } from '../../studio/mod.ts';
import {
  createStudioHandler,
  noQuestions,
  questionsFault,
  type StudioDescription,
} from '../../studio/server/handler.ts';
import { projectDiffers } from '../../studio/server/save.ts';
import { workspaceFromDraft } from '../../studio/workspace.ts';
import type { DecisionQuestionsBuilder } from '../../web/src/server/mod.ts';

const HOST = '127.0.0.1:4983';
const BASE = `http://${HOST}/api/studio`;

for (const id of ['triage-desk', 'unasked-desk']) {
  registerProfile({
    type: 'decision',
    id,
    identity: { handle: 'triage' },
    models: {
      jev: { protocol: 'systemOne', provider: 'typesafe', apiId: 'jev-latest', timeoutMs: 1000 },
    },
    inputs: { state: 'json', maxStateBytes: 200 },
    decision: { contract: 'test.v1' },
  });
}

const questions: Record<string, DecisionQuestion> = {
  next: {
    type: 'choice',
    instructions: 'Choose the safest next action.',
    criteria: { ask_user: 'Request authorization.', execute: 'Perform the deletion.' },
  },
};
const jevReply = {
  model: 'jev-1.13.0',
  answers: {
    next: {
      type: 'choice',
      choice: 'ask_user',
      confidence: 0.9,
      probabilities: { ask_user: 0.9, execute: 0.1 },
    },
  },
  usage: { input_tokens: 1000, output_tokens: 5 },
};
const asked: unknown[] = [];

const handler = createStudioHandler({
  conversationKey: newConversationKey(),
  project: 'decisions',
  pageOrigins: [],
  listenHost: HOST,
  questions: { 'triage-desk': questions },
  provider: {
    vault: { slot_a: 'k' },
    fetch: (_url, init) => {
      asked.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json(jevReply));
    },
  },
});

function call(path: string, body?: unknown): Promise<Response> {
  return handler(
    new Request(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

Deno.test('a decision profile opens with the questions the setup names', async () => {
  const described: StudioDescription = await (await call('')).json();
  const agent = described.workspace.agents.find((held) => held.identity.agentId === 'triage-desk');
  assertEquals(
    agent?.decision.questions.map((question) => [question.id, question.type]),
    [['next', 'choice']],
  );
});

Deno.test('a decision profile shows the page its questions, without their instructions', async () => {
  const response = await call('/profiles/triage-desk');
  const text = await response.text();
  assertEquals(response.status, 200);
  assertEquals(text.includes('safest'), false);
  assertEquals(JSON.parse(text).interface.questions, [
    { id: 'next', type: 'choice', labels: ['ask_user', 'execute'] },
  ]);
});

Deno.test("a decision is asked the setup's questions about the state the page sends", async () => {
  asked.length = 0;
  const response = await call('/profiles/triage-desk/decide', { state: { action: 'delete' } });
  assertEquals(response.status, 200);
  const { result } = await response.json();
  assertEquals(result.answers.next.choice, 'ask_user');
  assertEquals(asked.length, 1);
});

Deno.test('a decision that fails tells the builder why, not the visitor wording', async () => {
  const keyless = createStudioHandler({
    conversationKey: newConversationKey(),
    project: 'decisions',
    pageOrigins: [],
    listenHost: HOST,
    questions: { 'triage-desk': questions },
  });
  const response = await keyless(
    new Request(`${BASE}/profiles/triage-desk/decide`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ state: { action: 'delete' } }),
    }),
  );
  const reply = await response.json();
  assertEquals([response.status, reply.errorKind], [401, 'auth']);
  assertEquals(reply.error, "The vault has no credential in slot 'slot_a'");
});

Deno.test('a decision profile the setup names no questions for is not run, and says why', async () => {
  const described: StudioDescription = await (await call('')).json();
  assertEquals(
    described.problems.filter((problem) => problem.profile === 'unasked-desk'),
    [{ profile: 'unasked-desk', message: noQuestions('unasked-desk') }],
  );
  assertEquals((await call('/profiles/unasked-desk')).status, 404);
  assertEquals(
    described.workspace.agents.map((held) => held.identity.agentId),
    ['triage-desk'],
  );
  assertEquals(
    described.problems.some((problem) => problem.profile === 'triage-desk'),
    false,
  );
});

Deno.test('questions a setup file wrote wrongly are named, not run', () => {
  assertEquals(questionsFault('desk', undefined), noQuestions('desk'));
  assertEquals(questionsFault('desk', {}), noQuestions('desk'));
  assertEquals(questionsFault('desk', questions), undefined);
  assertEquals(
    questionsFault('desk', { risk: { type: 'score', instructions: 'How risky?' } }),
    "The question 'risk' the setup file exports for desk needs criteria: a list, lowest score first.",
  );
  assertEquals(
    questionsFault('desk', { next: { type: 'choice', instructions: 'Which?', criteria: {} } }),
    "The question 'next' the setup file exports for desk needs criteria: an object of the labels it picks from.",
  );
  assertEquals(
    questionsFault('desk', { next: { type: 'pick', instructions: 'Which?' } }),
    "The question 'next' the setup file exports for desk needs a type: 'choice', 'noul', 'score', or 'box'.",
  );
});

Deno.test('a decision made in the studio loads from its files as what was tested', async () => {
  const tested = workspaceFromDraft(await createDecisionExampleDraft());
  const compiled = compileWorkspace(tested, ON_OWN_KEYS);
  if (!compiled.ok) throw new Error(compiled.issues.map((issue) => issue.message).join(' '));
  const [made] = compiled.agents;
  // What Save writes: the profile registered, and its questions and pictures under its id in the setup's exports.
  registerProfile(made.profile);
  const saved = (asks: Record<string, DecisionQuestion>) =>
    createStudioHandler({
      conversationKey: newConversationKey(),
      project: 'decisions',
      pageOrigins: [],
      listenHost: HOST,
      questions: { [made.agentId]: asks },
      ...(made.images ? { images: { [made.agentId]: made.images } } : {}),
    })(new Request(BASE, { headers: { host: HOST } })).then(
      (response) => response.json() as Promise<StudioDescription>,
    );
  const others = ['triage-desk', 'unasked-desk'];
  // The providers are the project's own, as the page that tested it held them.
  const differs = async (asks: Record<string, DecisionQuestion>) => {
    const { workspace } = await saved(asks);
    const page = { ...tested, providers: workspace.providers };
    return projectDiffers(workspace, page).filter((id) => !others.includes(id));
  };

  assertEquals(await differs(made.questions ?? {}), []);
  // Files that ask something else are not what was tested.
  assertEquals(await differs(questions), [made.agentId]);
});

registerProfile({
  type: 'decision',
  id: 'reader-desk',
  identity: { handle: 'reader' },
  models: {
    jev: { protocol: 'systemOne', provider: 'typesafe', apiId: 'jev-latest', timeoutMs: 1000 },
  },
  inputs: { state: 'json', maxStateBytes: 400 },
  decision: { contract: 'reader.v1' },
});

/** One question per passage in the state, about the topic the run's form names. */
const topic = z.object({ topic: z.string().min(1) });
const perPassage: DecisionQuestionsBuilder<unknown> = {
  input: topic,
  build: ({ state, input }) =>
    Object.fromEntries(
      Object.keys((state as { passages: Record<string, string> }).passages).map((id) => [
        id,
        {
          type: 'choice' as const,
          instructions: `Does state.passages.${id} speak to ${topic.parse(input).topic}?`,
          criteria: { ask_user: 'It does.', execute: 'It does not.' },
        },
      ]),
    ),
};

const built = createStudioHandler({
  conversationKey: newConversationKey(),
  project: 'decisions',
  pageOrigins: [],
  listenHost: HOST,
  questions: { 'reader-desk': perPassage },
  provider: {
    vault: { slot_a: 'k' },
    fetch: (_url, init) => {
      asked.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json(jevReply));
    },
  },
});

function callBuilt(path: string, body?: unknown): Promise<Response> {
  return built(
    new Request(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

Deno.test('a decision whose questions the app builds opens holding none, and compiles', async () => {
  const described: StudioDescription = await (await callBuilt('')).json();
  const agent = described.workspace.agents.find((held) => held.identity.agentId === 'reader-desk');
  assertEquals([agent?.decision.questionsBuilt, agent?.decision.questions], [true, []]);
  assertEquals(
    described.problems.some((problem) => problem.profile === 'reader-desk'),
    false,
  );
  const compiled = compileWorkspace(described.workspace, ON_OWN_KEYS);
  assertEquals(compiled.ok, true);
});

Deno.test("a built decision shows the page its builder's input, and asks what it builds", async () => {
  const { interface: iface } = await (await callBuilt('/profiles/reader-desk')).json();
  assertEquals([iface.questions, iface.build.input.required], [[], ['topic']]);
  asked.length = 0;
  const response = await callBuilt('/profiles/reader-desk/decide', {
    state: { passages: { next: 'Ferns like shade.' } },
    input: { topic: 'light' },
  });
  const { result } = await response.json();
  assertEquals(response.status, 200);
  assertEquals(result.questions, [{ id: 'next', type: 'choice', labels: ['ask_user', 'execute'] }]);
  assertEquals(JSON.stringify(asked).includes('speak to light'), true);
});

Deno.test('a builder whose input is not a zod schema is named, not run', () => {
  assertEquals(questionsFault('desk', perPassage), undefined);
  assertEquals(questionsFault('desk', { build: () => ({}) }), undefined);
  assertEquals(
    questionsFault('desk', { input: { topic: 'string' }, build: () => ({}) }),
    'The questions the setup file exports for desk build from an `input` that is not a zod schema.',
  );
});
