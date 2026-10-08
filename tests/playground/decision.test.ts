import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
  compilePlayground,
  createDecisionExampleDraft,
  createExampleDraft,
  createSpanExampleDraft,
  decisionStateViolation,
  draftFacets,
  exampleDecisionDraft,
  JEV_PLAYGROUND_API_ID,
  newCriteria,
  newDecisionQuestion,
  PLAYGROUND_DECISION_MAX_CRITERIA,
  PLAYGROUND_DECISION_MAX_QUESTIONS,
  PLAYGROUND_DECISION_MAX_STATE_BYTES,
  PLAYGROUND_DECISION_TIMEOUT_MS,
  type PlaygroundDraft,
  type PlaygroundIssue,
  playgroundDecisionRequestSchema,
  playgroundNodeRef,
  playgroundSource,
  playgroundTree,
  setProfileType,
} from '../../playground/mod.ts';
import { defineProfile } from '../../src/kernel/mod.ts';

function withQuestions(
  draft: PlaygroundDraft,
  edit: (
    questions: PlaygroundDraft['decision']['questions'],
  ) => PlaygroundDraft['decision']['questions'],
): PlaygroundDraft {
  return { ...draft, decision: { ...draft.decision, questions: edit(draft.decision.questions) } };
}

function issues(draft: PlaygroundDraft): PlaygroundIssue[] {
  const result = compilePlayground(draft);
  if (result.ok) throw new Error('expected issues');
  return result.issues;
}

Deno.test('the decision example is a new decision agent on Jev, and compiles', () => {
  const draft = createDecisionExampleDraft();
  const result = compilePlayground(draft);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  assert(result.profile.type === 'decision');
  assertEquals(result.profile.models.decision.apiId, JEV_PLAYGROUND_API_ID);
  assertEquals(
    draft.decision.questions.map((question) => question.id),
    exampleDecisionDraft().questions.map((question) => question.id),
  );
});

Deno.test('the Span example compiles to the free model with Number questions', () => {
  const result = compilePlayground(createSpanExampleDraft());
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const { profile, questions } = result;
  assert(profile.type === 'decision');
  assertEquals(Object.keys(profile.models), ['decision']);
  assertEquals(profile.inputs, {
    state: 'json',
    maxStateBytes: PLAYGROUND_DECISION_MAX_STATE_BYTES,
  });
  assertEquals(profile.decision.contract, 'guardrails.tool_call.v1');
  assertEquals(profile.models.decision.apiId, 'respan/span-01-lite:free');
  assertEquals(questions?.verdict.type, 'noul');
  assertEquals(
    questions?.verdict.type === 'noul' && Object.keys(questions.verdict.criteria ?? {}),
    ['true', 'false'],
  );
  assertEquals(result.customTools, []);
});

Deno.test('decision compilation and the hosted request agree on text and timeout limits', () => {
  const span = createSpanExampleDraft();
  for (const change of [
    {
      ...span,
      modelBindings: [{ ...span.modelBindings[0], timeoutMs: PLAYGROUND_DECISION_TIMEOUT_MS + 1 }],
    },
    { ...span, decision: { ...span.decision, contract: 'c'.repeat(129) } },
    withQuestions(span, (qs) => [{ ...qs[0], id: 'q'.repeat(65) }]),
    { ...span, identity: { ...span.identity, handle: 'h'.repeat(65) } },
    withQuestions(span, (qs) => [
      { ...qs[0], criteria: [{ ...qs[0].criteria[0], label: 'l'.repeat(65) }, qs[0].criteria[1]] },
    ]),
  ])
    assert(!compilePlayground(change).ok);
  for (const draft of [span, setProfileType(createExampleDraft(), 'decision')]) {
    const compiled = compilePlayground(draft);
    assert(compiled.ok);
    const { profile, questions } = compiled;
    const parsed = playgroundDecisionRequestSchema.parse({ profile, questions, state: 'test' });
    assertEquals(Object.values(parsed.profile.models)[0].timeoutMs, PLAYGROUND_DECISION_TIMEOUT_MS);
  }
});

Deno.test('decision ids and criteria labels may match inherited object property names', () => {
  const draft = setProfileType(createExampleDraft(), 'decision');
  const compiled = compilePlayground(
    withQuestions(draft, (qs) => [
      {
        ...qs[0],
        id: 'constructor',
        criteria: [
          { key: 'one', label: 'constructor', text: 'First option.' },
          { key: 'two', label: 'toString', text: 'Second option.' },
        ],
      },
    ]),
  );
  assert(compiled.ok);
  assertEquals(Object.keys(compiled.questions ?? {}), ['constructor']);
  const question = compiled.questions?.[String('constructor')];
  assert(question?.type === 'choice');
  assertEquals(Object.keys(question.criteria), ['constructor', 'toString']);
});

Deno.test('Span messages reject empty or invalid shapes and accept role/content messages', () => {
  const binding = createSpanExampleDraft().modelBindings[0];
  for (const state of [
    {},
    { input: null },
    { output: 123 },
    { input: [] },
    { input: [{}] },
    { output: { role: 'assistant', content: 4 } },
  ]) {
    assert(decisionStateViolation(binding, state) !== null);
  }
  assertEquals(
    decisionStateViolation(binding, {
      input: [{ role: 'user', content: 'request' }],
      output: { role: 'assistant', content: 'response' },
    }),
    null,
  );
});

Deno.test('switching to decision loads the original Jev model and tool-call example', () => {
  const example = createExampleDraft();
  const decision = setProfileType(example, 'decision');
  assertEquals(decision.modelBindings.length, 1);
  assertEquals(decision.modelBindings[0].protocol, 'decision');
  assertEquals(decision.modelBindings[0].provider, 'typesafe');
  assertEquals(decision.modelBindings[0].apiId, 'jev-latest');
  assertEquals(
    decision.decision.questions.map(({ id, type }) => ({ id, type })),
    [
      { id: 'verdict', type: 'choice' },
      { id: 'risk', type: 'score' },
    ],
  );
  assertEquals(
    decision.decision.questions[0].criteria.map(({ label }) => label),
    ['allow', 'flag', 'block'],
  );
  assert(compilePlayground(decision).ok);
  assertEquals(draftFacets(decision), ['identity', 'models', 'decision', 'wording']);
  const models = playgroundTree(decision).children.find((node) => node.id === 'models');
  assertEquals(models?.children.length, 1);
  assertEquals(
    playgroundNodeRef(decision, `modelBinding:${decision.modelBindings[0].key}`)?.facet,
    'modelBinding',
  );
  const back = setProfileType(decision, 'text');
  assertEquals(back.modelBindings[0].protocol, 'geminiInteractions');
  assert(compilePlayground(back).ok);
});

Deno.test('a duplicate question id is keyed to the second question', () => {
  const found = issues(
    withQuestions(createSpanExampleDraft(), (qs) => [
      qs[0],
      { ...qs[0], key: 'second', id: qs[0].id },
    ]),
  );
  assertEquals(
    found.map(({ field, index }) => [field, index]),
    [['questions', 1]],
  );
});

Deno.test('a question without instructions or enough criteria is an issue on that question', () => {
  const draft = createSpanExampleDraft();
  const bare = newDecisionQuestion(draft, 'choice');
  const found = issues(
    withQuestions(draft, (qs) => [
      ...qs,
      { ...bare, instructions: 'Pick one.', criteria: newCriteria('choice').slice(0, 1) },
      { ...newDecisionQuestion(draft, 'score'), id: 'scale', instructions: 'Rate it.' },
      { ...bare, id: 'bare' },
    ]),
  );
  assert([1, 2, 3].every((index) => found.some((issue) => issue.index === index)));
  assert(found.every((issue) => issue.nodeId === 'decision' && issue.field === 'questions'));
});

Deno.test('Span requires true and false number criteria in the playground', () => {
  const draft = createSpanExampleDraft();
  const bare = withQuestions(draft, () => [
    { ...newDecisionQuestion(draft, 'noul'), instructions: 'Is it safe?' },
  ]);
  assert(issues(bare).some((issue) => issue.message.includes('true and false criteria')));
});

Deno.test('the playground caps questions, criteria, state, and the model', () => {
  const draft = createSpanExampleDraft();
  const many = withQuestions(draft, (qs) =>
    Array.from({ length: PLAYGROUND_DECISION_MAX_QUESTIONS + 1 }, (_, n) => ({
      ...qs[0],
      id: `q${n}`,
    })),
  );
  assert(issues(many).some((issue) => issue.field === 'questions' && issue.index === undefined));

  const wide = withQuestions(draft, (qs) => [
    {
      ...qs[0],
      criteria: Array.from({ length: PLAYGROUND_DECISION_MAX_CRITERIA + 1 }, (_, n) => ({
        key: `c${n}`,
        label: `option_${n}`,
        text: '',
      })),
    },
  ]);
  assert(issues(wide).some((issue) => issue.index === 0));

  const big = {
    ...draft,
    decision: { ...draft.decision, maxStateBytes: PLAYGROUND_DECISION_MAX_STATE_BYTES + 1 },
  };
  assertEquals(
    issues(big).map((issue) => issue.field),
    ['maxStateBytes'],
  );

  const other = { ...draft, modelBindings: [{ ...draft.modelBindings[0], apiId: 'jev-other' }] };
  assertEquals(
    issues(other).map(({ nodeId, field }) => [nodeId, field]),
    [[`modelBinding:${draft.modelBindings[0].key}`, 'apiId']],
  );
});

Deno.test('playground policy restricts OpenRouter decisions and permits TypeSafe', () => {
  const draft = createSpanExampleDraft();
  for (const apiId of ['jaredpalmer/kev-4b', '~typesafe/jev-latest', 'respan/span-01']) {
    const modelBindings = [{ ...draft.modelBindings[0], provider: 'openrouter' as const, apiId }];
    assert(issues({ ...draft, modelBindings }).some((issue) => issue.field === 'apiId'));
  }
  assert(
    compilePlayground({
      ...draft,
      modelBindings: [{ ...draft.modelBindings[0], provider: 'typesafe', apiId: 'jev-latest' }],
    }).ok,
  );
});

Deno.test('Span compatibility errors stay in the playground builder', () => {
  const draft = createSpanExampleDraft();
  const span = {
    ...draft,
    modelBindings: [
      {
        ...draft.modelBindings[0],
        provider: 'openrouter' as const,
        apiId: 'respan/span-01-lite:free',
      },
    ],
  };
  assert(
    issues({
      ...span,
      decision: {
        ...span.decision,
        questions: [{ ...span.decision.questions[0], type: 'choice' }],
      },
    }).some((issue) => issue.message.includes('Span accepts Number')),
  );
  const noul = { ...newDecisionQuestion(span, 'noul'), id: 'verdict', instructions: 'Is it safe?' };
  const wrongCriteria = { ...span, decision: { ...span.decision, questions: [noul] } };
  assertEquals(issues(wrongCriteria).filter((issue) => issue.field === 'questions').length, 1);
});

Deno.test('Span state policy accepts text or input/output messages', () => {
  const binding = createSpanExampleDraft().modelBindings[0];
  assertEquals(decisionStateViolation(binding, 'request text'), null);
  assertEquals(decisionStateViolation(binding, { input: 'request', output: 'response' }), null);
  assertStringIncludes(decisionStateViolation(binding, { unrelated: true }) ?? '', 'Span state');
});

Deno.test('playgroundSource writes the questions beside the profile', () => {
  const result = compilePlayground(setProfileType(createExampleDraft(), 'decision'));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const source = playgroundSource(result);
  assertStringIncludes(source, 'type DecisionQuestion');
  assertStringIncludes(source, 'satisfies Record<string, DecisionQuestion>;');
  assertStringIncludes(source, "contract: 'guardrails.tool_call.v1'");
});

Deno.test('the hosted decision request keeps the key slots the draft chose', () => {
  const draft = setProfileType(createExampleDraft(), 'decision');
  const compiled = compilePlayground({
    ...draft,
    models: { ...draft.models, key: 'house' },
    modelBindings: [{ ...draft.modelBindings[0], keySlot: 'openrouter' }],
  });
  assert(compiled.ok);
  const { profile, questions } = compiled;
  const parsed = playgroundDecisionRequestSchema.parse({ profile, questions, state: 'test' });
  assertEquals('key' in parsed.profile, false);
  assertEquals(Object.values(parsed.profile.models)[0].keySlot, 'openrouter');
  defineProfile(parsed.profile as typeof profile);
  assert(
    !playgroundDecisionRequestSchema.safeParse({
      profile: {
        ...profile,
        models: { decision: { provider: 'openrouter', apiId: 'test', keySlot: 'not a slot' } },
      },
      questions,
      state: 'test',
    }).success,
  );
});
