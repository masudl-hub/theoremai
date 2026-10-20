import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { type LentKeys, ON_OWN_KEYS, type StudioRunsOn } from '../../studio/lent-keys.ts';
import {
  compileStudio,
  createDecisionExampleDraft,
  createExampleDraft,
  createSpanExampleDraft,
  DECISION_EXAMPLE_STATE,
  decisionExampleAssets,
  draftFacets,
  newCriteria,
  newDecisionImage,
  newDecisionQuestion,
  readStudioSource,
  type StudioDraft,
  type StudioIssue,
  setProfileType,
  studioNodeRef,
  studioSource,
  studioTree,
} from '../../studio/mod.ts';
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

Deno.test('the decision example asks Jev 1.14 about the pantry, with images on', async () => {
  const result = compileStudio(await createDecisionExampleDraft(), ON_OWN_KEYS);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const { profile, questions } = result;
  assert(profile.type === 'decision');
  assertEquals(profile.models.decision.apiId, 'jev-1.14.0');
  assertEquals(profile.models.decision.options, { images: true });
  assertEquals(
    Object.fromEntries(Object.entries(questions ?? {}).map(([id, each]) => [id, each.type])),
    {
      Ginger: 'box',
      'Something to drink': 'noul',
      'Fruit salad': 'noul',
      'Where the green apple lands on the chart': 'box',
      'Bread on the shelf': 'noul',
      'Union Jack': 'box',
      Brunch: 'choice',
    },
  );
});

/** A PNG's or JPEG's width and height, read from its header. */
function imageSize(data: string): [number, number] {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  if (bytes[0] === 0x89) return [view.getUint32(16), view.getUint32(20)];
  assertEquals([...bytes.slice(0, 3)], [0xff, 0xd8, 0xff]);
  // The size sits in the first start-of-frame marker (SOF0 to SOF2).
  let at = 2;
  while (bytes[at + 1] < 0xc0 || bytes[at + 1] > 0xc2) at += 2 + view.getUint16(at + 2);
  return [view.getUint16(at + 7), view.getUint16(at + 5)];
}

Deno.test('the decision example writes every picture it ships, each in TypeSafe image limits', async () => {
  const draft = await createDecisionExampleDraft();
  const written = [DECISION_EXAMPLE_STATE, ...draft.decision.questions.map((q) => q.instructions)];
  const fixed = draft.decision.images.map((image) => [`<${image.name}>`, image] as const);
  for (const [reference, image] of [...Object.entries(await decisionExampleAssets()), ...fixed]) {
    // TypeSafe refuses a request with an image nothing refers to.
    assert(
      written.some((text) => text.includes(reference)),
      reference,
    );
    const [width, height] = imageSize(image.data);
    assert(width >= 280 && height >= 280 && width <= 1568 && height <= 1568, reference);
    assert(width * height >= 78_400 && width * height <= 2_458_624, reference);
  }
});

Deno.test('on keys that take no images, a Box question is an issue on that question', async () => {
  const keys: LentKeys = { ...TEST_KEYS, decision: { ...TEST_KEYS.decision, images: 0 } };
  const found = issues(await createDecisionExampleDraft(), { mode: 'demo', keys });
  assert(found.some((issue) => issue.message.includes('take no images')));
  assert(compileStudio(await createDecisionExampleDraft(), ON_TEST_KEYS).ok);
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

Deno.test('on lent keys a decision is held to their text and timeout limits, and on its own keys it is not', async () => {
  const jev = await createDecisionExampleDraft();
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
  assertEquals(back.modelBindings[0].provider, 'gemini');
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

Deno.test('lent keys cap questions, criteria, state, and the model', async () => {
  const draft = await createDecisionExampleDraft();
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

Deno.test('a question the lent keys refuse is an issue on that question', async () => {
  const keys: LentKeys = {
    ...TEST_KEYS,
    questionViolation: (_, question) =>
      question.type === 'choice' ? 'No choices on these keys.' : null,
  };
  const found = issues(await createDecisionExampleDraft(), { mode: 'demo', keys });
  assertEquals(
    found.map(({ field, index, message }) => [field, index, message]),
    [['questions', 6, 'No choices on these keys.']],
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

Deno.test('a Box question compiles to instructions alone, and keeps no criteria', async () => {
  const jev = await createDecisionExampleDraft();
  const box = {
    ...newDecisionQuestion(jev, 'box'),
    id: 'cup',
    instructions: 'Where is the cup in the first image?',
  };
  assertEquals(newCriteria('box'), []);
  const result = compileStudio(
    withQuestions(jev, () => [{ ...box, criteria: newCriteria('choice') }]),
    ON_OWN_KEYS,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  assertEquals(result.questions?.cup, {
    type: 'box',
    instructions: 'Where is the cup in the first image?',
  });
});

function withImages(
  draft: StudioDraft,
  edit: (images: StudioDraft['decision']['images']) => StudioDraft['decision']['images'],
): StudioDraft {
  return { ...draft, decision: { ...draft.decision, images: edit(draft.decision.images) } };
}

Deno.test('a decision sends its own pictures, and a question names only those', async () => {
  const draft = await createDecisionExampleDraft();
  const result = compileStudio(draft, ON_OWN_KEYS);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  assertEquals(Object.keys(result.images ?? {}), ['<ginger>', '<union_jack>', '<apple_ripeness>']);
  assertEquals(
    issues(withImages(draft, () => [])).map(({ field, index, message }) => [field, index, message]),
    [
      ['questions', 0, 'No image is named <ginger>.'],
      ['questions', 3, 'No image is named <apple_ripeness>.'],
      ['questions', 5, 'No image is named <union_jack>.'],
    ],
  );
  const [ginger, flag, chart] = draft.decision.images;
  assertEquals(
    issues(withImages(draft, () => [ginger, { ...flag, name: 'ginger' }, chart])).map(
      ({ field, index }) => [field, index],
    ),
    [
      ['images', 1],
      ['questions', 5],
    ],
  );
  assertEquals(
    issues(withImages(draft, () => [ginger, flag, chart, { ...flag, name: 'Union Jack' }])).map(
      ({ field, index }) => [field, index],
    ),
    [['images', 3]],
  );
});

Deno.test('lent keys cap how many pictures a decision sends, and what each weighs', async () => {
  const draft = await createDecisionExampleDraft();
  const keys: LentKeys = {
    ...TEST_KEYS,
    decision: { ...TEST_KEYS.decision, images: 1, imageBytes: 10 },
  };
  assertEquals(
    issues(draft, { mode: 'demo', keys }).map(({ field, index }) => [field, index]),
    [
      ['images', undefined],
      ['images', 0],
      ['images', 1],
      ['images', 2],
    ],
  );
});

Deno.test('studioSource writes the pictures beside the questions, and reads them back by name', async () => {
  const draft = await createDecisionExampleDraft();
  const result = compileStudio(draft, ON_OWN_KEYS);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const source = studioSource(result);
  assertStringIncludes(source, 'satisfies Record<string, DecisionAsset>;');
  const read = readStudioSource(source, draft);
  if (!read.ok) throw new Error(JSON.stringify(read.errors));
  assertEquals(read.draft.decision.images, draft.decision.images);
});

Deno.test('an added picture is named after its file, and numbered after a name the draft has', async () => {
  const draft = await createDecisionExampleDraft();
  const png = { mimeType: 'image/png', data: 'AAAA' };
  assertEquals(newDecisionImage(draft, 'GHS 02.png', png).name, 'ghs_02');
  assertEquals(newDecisionImage(draft, 'ginger.jpg', png).name, 'ginger_2');
  assertEquals(newDecisionImage(draft, '__My shelf!!.png', png).name, 'my_shelf');
  assertEquals(newDecisionImage(draft, '.png', png).name, 'image');
});

Deno.test("a box's image is one of the decision's own, and goes to source and back", async () => {
  const draft = await createDecisionExampleDraft();
  const result = compileStudio(draft, ON_OWN_KEYS);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const chart = 'Where the green apple lands on the chart';
  assertEquals(result.questions?.[chart], {
    type: 'box',
    instructions: 'Where on <apple_ripeness> would the green apple in `photo` sit?',
    image: '<apple_ripeness>',
  });
  const read = readStudioSource(studioSource(result), draft);
  if (!read.ok) throw new Error(JSON.stringify(read.errors));
  assertEquals(read.draft.decision.questions[3].image, '<apple_ripeness>');
  const moved = {
    ...draft,
    decision: {
      ...draft.decision,
      questions: draft.decision.questions.map((question, index) =>
        index === 3 ? { ...question, image: '<orchard>' } : question,
      ),
    },
  };
  assertEquals(
    issues(moved).map(({ field, index, message }) => [field, index, message]),
    [['questions', 3, 'No image is named <orchard>.']],
  );
});
