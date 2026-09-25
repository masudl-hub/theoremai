import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { standardEgressEnforce } from '../../mod.ts';
import {
  compilePlayground,
  createBlankDraft,
  createExampleDraft,
  defaultToolSpec,
  demoToolSpecs,
  excludeFacet,
  GEMINI_PLAYGROUND_DEFAULT_API_ID,
  GEMINI_PLAYGROUND_IMAGE_DEFAULT_API_ID,
  GEMINI_PLAYGROUND_LIVE_DEFAULT_API_ID,
  GEMINI_PLAYGROUND_TTS_DEFAULT_API_ID,
  includeFacet,
  modelBindingNodeId,
  modelBindingViolation,
  newModelBinding,
  newToolSpec,
  OPENROUTER_PLAYGROUND_API_ID,
  type PlaygroundCompileResult,
  type PlaygroundDraft,
  playgroundNodeRef,
  playgroundSource,
  playgroundTree,
  setProfileType,
  toolSpecNodeId,
  zodFromJsonSchema,
} from '../../playground/mod.ts';
import { quoteSource } from '../../playground/tool-schema.ts';

function compiled(draft: PlaygroundDraft) {
  const result = compilePlayground(draft);
  if (!result.ok) throw new Error(`unexpected issues: ${JSON.stringify(result.issues)}`);
  return result;
}

function issueNodes(result: PlaygroundCompileResult): string[] {
  if (result.ok) throw new Error('expected issues');
  return result.issues.map((issue) => issue.nodeId);
}

Deno.test('the example draft compiles to the travel concierge', () => {
  const result = compiled(createExampleDraft());
  const { profile } = result;
  assertEquals(result.agentId, 'travel.concierge');
  assertEquals(profile.type, 'text');
  assertEquals(Object.keys(profile.models), ['fast', 'smart', 'open']);
  assertEquals(profile.defaultModel, 'fast');
  assertEquals(result.customTools.length, demoToolSpecs().length);
  assert(profile.type === 'text' && profile.tools?.allow?.includes('geocode_city'));
  assertEquals(profile.guardrails?.egress?.enforce, standardEgressEnforce);
  assertEquals(profile.observability?.writeTo, 'playground');
});

Deno.test('a blank draft reports its identity issues', () => {
  const nodes = issueNodes(compilePlayground(createBlankDraft()));
  assert(nodes.length > 0);
  assert(nodes.every((node) => node === 'identity'));
});

Deno.test('a binding issue is keyed to its binding node', () => {
  const draft = createExampleDraft();
  const open = draft.modelBindings[2];
  const result = compilePlayground({
    ...draft,
    modelBindings: [...draft.modelBindings.slice(0, 2), { ...open, apiId: 'openai/gpt-5' }],
  });
  assertEquals(issueNodes(result), [modelBindingNodeId(open.key)]);
  assert(!result.ok);
  assertEquals(result.issues[0].field, 'apiId');
});

Deno.test('a model with several efforts and no default is an issue on its default effort', () => {
  const draft = createExampleDraft();
  const [fast, ...rest] = draft.modelBindings;
  const result = compilePlayground({
    ...draft,
    modelBindings: [{ ...fast, defaultEffort: '' }, ...rest],
  });
  assert(!result.ok);
  assertEquals(
    result.issues.map(({ nodeId, field }) => ({ nodeId, field })),
    [{ nodeId: modelBindingNodeId(fast.key), field: 'defaultEffort' }],
  );
});

Deno.test('an issue names the draft field at fault, and the list entry when there is one', () => {
  const draft = createExampleDraft();
  const [fast, ...rest] = draft.modelBindings;
  const result = compilePlayground({
    ...draft,
    identity: { ...draft.identity, handle: ' ' },
    modelBindings: [
      {
        ...fast,
        efforts: [fast.efforts[0], { ...fast.efforts[1], alias: fast.efforts[0].alias }],
        defaultEffort: 'missing',
      },
      ...rest,
    ],
  });
  assert(!result.ok);
  assertEquals(
    result.issues.map(({ nodeId, field, index }) => ({ nodeId, field, index })),
    [
      { nodeId: 'identity', field: 'handle', index: undefined },
      { nodeId: modelBindingNodeId(fast.key), field: 'efforts', index: 1 },
      { nodeId: modelBindingNodeId(fast.key), field: 'allowEffortSelect', index: undefined },
      { nodeId: modelBindingNodeId(fast.key), field: 'defaultEffort', index: undefined },
    ],
  );
});

Deno.test('attachments or voice need every input limit, each an issue on its field', () => {
  const draft = createExampleDraft();
  const result = compilePlayground({
    ...draft,
    inputs: { ...draft.inputs, maxFiles: null, maxBytes: null, maxTurnBytes: null },
  });
  assert(!result.ok);
  assertEquals(
    result.issues.map(({ nodeId, field }) => ({ nodeId, field })),
    [
      { nodeId: 'inputs', field: 'maxFiles' },
      { nodeId: 'inputs', field: 'maxBytes' },
      { nodeId: 'inputs', field: 'maxTurnBytes' },
    ],
  );
  compiled({
    ...draft,
    inputs: {
      ...draft.inputs,
      attachmentsAccept: [],
      voiceAccept: [],
      maxFiles: null,
      maxBytes: null,
      maxTurnBytes: null,
    },
  });
});

Deno.test('summaries compile on, off, or left to the provider', () => {
  const draft = createExampleDraft();
  const [fast, ...rest] = draft.modelBindings;
  const summaries = (value: boolean | null) =>
    compiled({ ...draft, modelBindings: [{ ...fast, summaries: value }, ...rest] }).profile.models[
      fast.modelId
    ].summaries;
  assertEquals(summaries(true), true);
  assertEquals(summaries(false), false);
  assertEquals(summaries(null), undefined);
});

Deno.test('a duplicate tool name is keyed to the second tool', () => {
  const draft = createExampleDraft();
  const copy = defaultToolSpec({ toolName: draft.toolSpecs[0].toolName });
  const result = compilePlayground({ ...draft, toolSpecs: [...draft.toolSpecs, copy] });
  assertEquals(issueNodes(result), [toolSpecNodeId(copy.key)]);
});

Deno.test('setProfileType to live swaps bindings and drops facets live lacks', () => {
  const live = setProfileType(createExampleDraft(), 'live');
  assertEquals(live.modelBindings.length, 1);
  assertEquals(live.modelBindings[0].protocol, 'geminiLive');
  assertEquals(live.modelBindings[0].apiId, GEMINI_PLAYGROUND_LIVE_DEFAULT_API_ID);
  assertEquals(live.models.defaultModel, '');
  assertEquals(live.models.key, 'slotA');
  assertEquals(live.included, ['turnBehaviour', 'guardrails', 'observability']);
  const { profile } = compiled(live);
  assertEquals(profile.type, 'live');
});

Deno.test('live compression compiles to a sliding window, blanks left to the provider', () => {
  const live = setProfileType(createExampleDraft(), 'live');
  const on = { ...live.live, contextCompression: true };
  const bare = compiled({ ...live, live: on }).profile;
  assert(bare.type === 'live');
  assertEquals(bare.live.contextCompression, { slidingWindow: {} });
  const set = compiled({
    ...live,
    live: { ...on, compressionTriggerTokens: 100_000, compressionTargetTokens: 40_000 },
  }).profile;
  assert(set.type === 'live');
  assertEquals(set.live.contextCompression, {
    triggerTokens: 100_000,
    slidingWindow: { targetTokens: 40_000 },
  });
});

Deno.test('a compression target at or above the trigger is keyed to the target', () => {
  const live = setProfileType(createExampleDraft(), 'live');
  const result = compilePlayground({
    ...live,
    live: {
      ...live.live,
      contextCompression: true,
      compressionTriggerTokens: 50_000,
      compressionTargetTokens: 50_000,
    },
  });
  assert(!result.ok);
  assertEquals(
    result.issues.map((issue) => issue.field),
    ['compressionTargetTokens'],
  );
});

Deno.test('setProfileType keeps what the author typed for the way back', () => {
  const example = createExampleDraft();
  const back = setProfileType(setProfileType(example, 'image'), 'text');
  assertEquals(back.identity.system, example.identity.system);
  assertEquals(back.toolSpecs, example.toolSpecs);
});

Deno.test('setProfileType swaps models made for another type for the new default', () => {
  const image = setProfileType(createExampleDraft(), 'image');
  assertEquals(
    image.modelBindings.map((binding) => binding.apiId),
    [GEMINI_PLAYGROUND_IMAGE_DEFAULT_API_ID],
  );
  const speech = setProfileType(image, 'speech');
  assertEquals(
    speech.modelBindings.map((binding) => binding.apiId),
    [GEMINI_PLAYGROUND_TTS_DEFAULT_API_ID],
  );
  const text = setProfileType(speech, 'text');
  assertEquals(
    text.modelBindings.map((binding) => binding.apiId),
    [GEMINI_PLAYGROUND_DEFAULT_API_ID],
  );
});

Deno.test('setProfileType keeps a binding on a model the playground does not list', () => {
  const draft = createExampleDraft();
  const unlisted = { ...draft.modelBindings[0], apiId: 'gemini-unlisted' };
  const image = setProfileType({ ...draft, modelBindings: [unlisted] }, 'image');
  assertEquals(image.modelBindings, [unlisted]);
});

Deno.test('a speech profile compiles without a system prompt or canary', () => {
  const draft = setProfileType(createExampleDraft(), 'speech');
  const { profile } = compiled({ ...draft, guardrails: { ...draft.guardrails, canary: true } });
  assertEquals(profile.type, 'speech');
  assert(!('system' in (profile.identity ?? {})));
  assertEquals(profile.guardrails?.canary, undefined);
});

Deno.test('a draft compiles only the fields its type takes in the schema', () => {
  const image = includeFacet(setProfileType(createExampleDraft(), 'image'), 'turnBehaviour');
  const { profile } = compiled({
    ...image,
    turnBehaviour: {
      ...image.turnBehaviour,
      resumeEnabled: true,
      continueInstruction: 'Keep going.',
      allowSteering: false,
    },
  });
  assertEquals(profile.type, 'image');
  assertEquals(profile.turnBehaviour, { resumption: {} });
  assertEquals(profile.lexicon, undefined);

  const live = setProfileType(image, 'live');
  const liveProfile = compiled({ ...live, tools: { t2Loader: 'not_checked' } }).profile;
  assert(liveProfile.type === 'live');
  assertEquals(Object.keys(liveProfile.tools), ['allow']);
});

Deno.test('the continue instruction and canary bind note compile into the profile lexicon', () => {
  const text = includeFacet(includeFacet(createExampleDraft(), 'turnBehaviour'), 'guardrails');
  const draft = {
    ...text,
    turnBehaviour: {
      ...text.turnBehaviour,
      resumeEnabled: true,
      continueInstruction: ' Keep going. ',
    },
    guardrails: {
      ...text.guardrails,
      canary: true,
      canaryBindNote: 'Token {canary} stays secret.',
    },
  };
  const { profile } = compiled(draft);
  assertEquals(profile.lexicon, {
    'continue.instruction': 'Keep going.',
    'canary.bind_note': 'Token {canary} stays secret.',
  });
  const off = compiled({
    ...draft,
    turnBehaviour: { ...draft.turnBehaviour, resumeEnabled: false },
    guardrails: { ...draft.guardrails, canary: false },
  });
  assertEquals(off.profile.lexicon, undefined);
});

Deno.test('a canary bind note without {canary} is an issue on the guardrails node', () => {
  const text = includeFacet(createExampleDraft(), 'guardrails');
  const result = compilePlayground({
    ...text,
    guardrails: { ...text.guardrails, canary: true, canaryBindNote: 'No token here.' },
  });
  assertEquals(issueNodes(result), ['guardrails']);
});

Deno.test('includeFacet only adds facets the type allows', () => {
  const live = setProfileType(createBlankDraft(), 'live');
  assertEquals(includeFacet(live, 'outputs'), live);
  const withGuardrails = includeFacet(live, 'guardrails');
  assertEquals(withGuardrails.included, ['observability', 'guardrails']);
  assertEquals(excludeFacet(withGuardrails, 'guardrails').included, ['observability']);
});

Deno.test('new bindings and tools get unused names', () => {
  const draft = setProfileType(createBlankDraft(), 'text');
  const second = newModelBinding(draft);
  assert(second.modelId !== draft.modelBindings[0].modelId);
  const first = newToolSpec(draft);
  assert(newToolSpec({ ...draft, toolSpecs: [first] }).toolName !== first.toolName);
});

Deno.test('the tree nests bindings and tools under their facets', () => {
  const draft = createExampleDraft();
  const tree = playgroundTree(draft);
  assertEquals(tree.label, 'travel.concierge');
  assertEquals(
    tree.children.map((node) => node.id),
    ['models', 'tools', 'inputs', 'outputs', 'turnBehaviour', 'guardrails', 'observability'],
  );
  const models = tree.children.find((node) => node.id === 'models');
  assertEquals(
    models?.children.map((node) => node.label),
    ['fast', 'smart', 'open'],
  );
});

Deno.test('playgroundNodeRef resolves only nodes the draft has', () => {
  const draft = createExampleDraft();
  const key = draft.modelBindings[0].key;
  assertEquals(playgroundNodeRef(draft, modelBindingNodeId(key)), { facet: 'modelBinding', key });
  assertEquals(playgroundNodeRef(draft, modelBindingNodeId('missing')), undefined);
  assertEquals(playgroundNodeRef(draft, 'outputs'), { facet: 'outputs' });
  assertEquals(playgroundNodeRef(excludeFacet(draft, 'outputs'), 'outputs'), undefined);
});

Deno.test('playgroundSource writes a module that registers the profile', () => {
  const source = playgroundSource(compiled(createExampleDraft()));
  assertStringIncludes(source, "import { z } from 'zod';");
  assertStringIncludes(source, "  standardEgressEnforce,\n} from '@theoremai/agents';");
  assertStringIncludes(source, 'enforce: standardEgressEnforce,');
  assertStringIncludes(source, "name: 'geocode_city',");
  assertStringIncludes(source, 'registerProfile(profile);');
});

Deno.test('playgroundSource writes structured output and function stubs', () => {
  const draft = setProfileType(createBlankDraft(), 'text');
  const source = playgroundSource(
    compiled({
      ...draft,
      identity: { ...draft.identity, agentId: 'demo.structured', handle: 'demo' },
      included: ['outputs'],
      toolSpecs: [newToolSpec(draft)],
      outputs: {
        ...draft.outputs,
        mode: 'structured',
        schemaId: 'answer',
        schemaJson: '{"type":"object","properties":{"answer":{"type":"string"}}}',
      },
    }),
  );
  assertStringIncludes(source, "registerStructured('answer', {");
  assertStringIncludes(source, 'handler: () => Promise.resolve(');
});

Deno.test('a new text profile starts on the playground Gemini model', () => {
  const draft = setProfileType(createBlankDraft(), 'text');
  assertEquals(draft.modelBindings[0].apiId, GEMINI_PLAYGROUND_DEFAULT_API_ID);
  assertEquals(draft.models.key, 'slotA');
  assertEquals(draft.included, ['observability']);
  assertEquals(draft.observability.writeTo, 'playground');
});

Deno.test('a new image profile starts on the playground Gemini image model', () => {
  const draft = setProfileType(createBlankDraft(), 'image');
  assertEquals(draft.modelBindings[0].provider, 'google');
  assertEquals(draft.modelBindings[0].apiId, GEMINI_PLAYGROUND_IMAGE_DEFAULT_API_ID);
  assertEquals(draft.models.key, 'slotA');
});

Deno.test('modelBindingViolation holds the playground to its free-tier keys', () => {
  const gemini = setProfileType(createBlankDraft(), 'text').modelBindings[0];
  assertEquals(modelBindingViolation(gemini), null);
  assertEquals(modelBindingViolation({ ...gemini, apiId: 'gemini-3-pro' })?.field, 'apiId');
  const openRouter = { ...gemini, protocol: 'openAi' as const, provider: 'openrouter' as const };
  assertEquals(modelBindingViolation({ ...openRouter, apiId: 'openai/gpt-5' })?.field, 'apiId');
  assertEquals(modelBindingViolation({ ...openRouter, apiId: OPENROUTER_PLAYGROUND_API_ID }), null);
});

Deno.test('zodFromJsonSchema keeps required fields and passes extras', () => {
  const schema = zodFromJsonSchema({
    type: 'object',
    properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
    required: ['name'],
  });
  assert(!schema.safeParse({ tags: [] }).success);
  assertEquals(schema.parse({ name: 'a', extra: 1 }), { name: 'a', extra: 1 });
});

Deno.test('quoteSource writes a string that evaluates back to itself, script-safe', () => {
  const text = `it's "quoted" \\ </script> \u2028\u2029 done`;
  const quoted = quoteSource(text);
  assertEquals(new Function(`return ${quoted};`)(), text);
  assertEquals(/[<>\u2028\u2029]/.test(quoted), false);
});
