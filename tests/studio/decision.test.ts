import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
  compileStudio,
  createDecisionExampleDraft,
  createExampleDraft,
  createSpanExampleDraft,
  draftFacets,
  exampleDecisionDraft,
  newCriteria,
  newDecisionQuestion,
  type StudioDraft,
  type StudioIssue,
  setProfileType,
  studioNodeRef,
  studioSource,
  studioTree,
} from '../../studio/mod.ts';
import { type LentKeys, ON_OWN_KEYS, type StudioRunsOn } from '../../studio/lent-keys.ts';
import { ON_TEST_KEYS, TEST_KEYS } from '../fixtures/lent-keys.ts';

function withQuestions(
  draft: StudioDraft,
  edit: (questions: StudioDraft['decision']['questions']) => StudioDraft['decision']['questions'],
): StudioDraft {
  return { ...draft, decision: { ...draft.decision, questions: edit(draft.decision.questions) } };
}

function issues(draft: StudioDraft, on: StudioRunsOn = ON_OWN_KEYS): StudioIssue[] {
  const result = compileStudio(draft, on);
  if (result.ok) throw new Error('expected issues');
  return result.issues;
}

Deno.test('the decision example is a new decision agent on Jev, and compiles', () => {
  const draft = createDecisionExampleDraft();
  const result = compileStudio(draft, ON_OWN_KEYS);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  assert(result.profile.type === 'decision');
  assertEquals(result.profile.models.decision.apiId, 'jev-latest');
  assertEquals(
    draft.decision.questions.map((question) => question.id),
    exampleDecisionDraft().questions.map((question) => question.id),
  );
});

Deno.test('the Span example compiles to the free model with Number questions', () => {
  const result = compileStudio(createSpanExampleDraft(), ON_OWN_KEYS);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const { profile, questions } = result;
  assert(profile.type === 'decision');
  assertEquals(Object.keys(profile.models), ['decision']);
  // The studio sets no state limit of its own: none is written, so none runs.
  assertEquals(profile.inputs, { state: 'json' });
  assertEquals(profile.decision.contract, 'guardrails.tool_call.v1');
  assertEquals(profile.models.decision.apiId, 'respan/span-01-lite:free');
  assertEquals(questions?.verdict.type, 'noul');
  assertEquals(
    questions?.verdict.type === 'noul' && Object.keys(questions.verdict.criteria ?? {}),
    ['true', 'false'],
  );
  assertEquals(result.customTools, []);
});

Deno.test('on lent keys a decision is held to their text and timeout limits, and on its own keys it is not', () => {
  const jev = createDecisionExampleDraft();
  const limits = TEST_KEYS.decision;
  for (const change of [
    { ...jev, modelBindings: [{ ...jev.modelBindings[0], timeoutMs: limits.timeoutMs + 1 }] },
    { ...jev, decision: { ...jev.decision, contract: 'c'.repeat(limits.idChars + 1) } },
    withQuestions(jev, (qs) => [{ ...qs[0], id: 'q'.repeat(limits.nameChars + 1) }]),
    { ...jev, identity: { ...jev.identity, handle: 'h'.repeat(limits.nameChars + 1) } },
  ]) {
    assert(!compileStudio(change, ON_TEST_KEYS).ok);
  }
  const unset = compileStudio(jev, ON_TEST_KEYS);
  assert(unset.ok && unset.profile.type === 'decision');
  // A timeout left out stays out: the keys hold a limit, they fill nothing.
  assertEquals(unset.profile.models.decision.timeoutMs, undefined);
  const slow = {
    ...jev,
    modelBindings: [{ ...jev.modelBindings[0], timeoutMs: limits.timeoutMs + 1 }],
  };
  assert(compileStudio(slow, ON_OWN_KEYS).ok);
});

Deno.test('decision ids and criteria labels may match inherited object property names', () => {
  const draft = setProfileType(createExampleDraft(), 'decision', TEST_KEYS);
  const compiled = compileStudio(
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
    ON_OWN_KEYS,
  );
  assert(compiled.ok);
  assertEquals(Object.keys(compiled.questions ?? {}), ['constructor']);
  const question = compiled.questions?.[String('constructor')];
  assert(question?.type === 'choice');
  assertEquals(Object.keys(question.criteria), ['constructor', 'toString']);
});

Deno.test('switching to decision loads the original Jev model and tool-call example', () => {
  const example = createExampleDraft();
  const decision = setProfileType(example, 'decision', TEST_KEYS);
  assertEquals(decision.modelBindings.length, 1);
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
  assert(compileStudio(decision, ON_OWN_KEYS).ok);
  assertEquals(draftFacets(decision), [
    'identity',
    'models',
    'decision',
    'observability',
    'labels',
  ]);
  const models = studioTree(decision).children.find((node) => node.id === 'models');
  assertEquals(models?.children.length, 1);
  assertEquals(
    studioNodeRef(decision, `modelBinding:${decision.modelBindings[0].key}`)?.facet,
    'modelBinding',
  );
  const back = setProfileType(decision, 'text', TEST_KEYS);
  assertEquals(back.modelBindings[0].provider, 'google');
  assert(compileStudio(back, ON_OWN_KEYS).ok);
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

Deno.test('lent keys cap questions, criteria, state, and the model', () => {
  const draft = createDecisionExampleDraft();
  const limits = TEST_KEYS.decision;
  const many = withQuestions(draft, (qs) =>
    Array.from({ length: limits.questions + 1 }, (_, n) => ({
      ...qs[0],
      id: `q${n}`,
    })),
  );
  assert(
    issues(many, ON_TEST_KEYS).some(
      (issue) => issue.field === 'questions' && issue.index === undefined,
    ),
  );

  const wide = withQuestions(draft, (qs) => [
    {
      ...qs[0],
      criteria: Array.from({ length: limits.criteria + 1 }, (_, n) => ({
        key: `c${n}`,
        label: `option_${n}`,
        text: 'An option.',
      })),
    },
  ]);
  assert(issues(wide, ON_TEST_KEYS).some((issue) => issue.index === 0));

  const big = {
    ...draft,
    decision: { ...draft.decision, maxStateBytes: limits.stateBytes + 1 },
  };
  assertEquals(
    issues(big, ON_TEST_KEYS).map((issue) => issue.field),
    ['maxStateBytes'],
  );
  assert(compileStudio(big, ON_OWN_KEYS).ok);

  const other = { ...draft, modelBindings: [{ ...draft.modelBindings[0], apiId: 'jev-other' }] };
  assertEquals(
    issues(other, ON_TEST_KEYS).map(({ nodeId, field }) => [nodeId, field]),
    [[`modelBinding:${draft.modelBindings[0].key}`, 'apiId']],
  );
});

Deno.test('a question the lent keys refuse is an issue on that question', () => {
  const keys: LentKeys = {
    ...TEST_KEYS,
    questionViolation: (_, question) =>
      question.type === 'score' ? 'No scores on these keys.' : null,
  };
  const found = issues(createDecisionExampleDraft(), { mode: 'demo', keys });
  assertEquals(
    found.map(({ field, index, message }) => [field, index, message]),
    [['questions', 1, 'No scores on these keys.']],
  );
});

Deno.test('studioSource writes the questions beside the profile', () => {
  const result = compileStudio(
    setProfileType(createExampleDraft(), 'decision', TEST_KEYS),
    ON_OWN_KEYS,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const source = studioSource(result);
  assertStringIncludes(source, 'type DecisionQuestion');
  assertStringIncludes(source, 'satisfies Record<string, DecisionQuestion>;');
  assertStringIncludes(source, "contract: 'guardrails.tool_call.v1'");
});
