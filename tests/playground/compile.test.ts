import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { isKeySlotName } from '../../mod.ts';
import {
  compilePlayground,
  createBlankDraft,
  createExampleDraft,
  defaultToolSpec,
  demoToolSpecs,
  draftAllows,
  draftFacets,
  excludeFacet,
  GEMINI_PLAYGROUND_DEFAULT_API_ID,
  GEMINI_PLAYGROUND_IMAGE_DEFAULT_API_ID,
  GEMINI_PLAYGROUND_LIVE_DEFAULT_API_ID,
  GEMINI_PLAYGROUND_LIVE_INPUT_TOKENS,
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
  removeModelBinding,
  setProfileType,
  toolSpecNodeId,
  updateModelBinding,
  zodFromJsonSchema,
} from '../../playground/mod.ts';
import { quoteSource } from '../../playground/tool-schema.ts';

Deno.test('renaming a binding preserves the selected default and leaves other bindings alone', () => {
  const draft = createExampleDraft();
  const renamed = updateModelBinding(draft, draft.modelBindings[0].key, { modelId: 'primary' });
  assertEquals(renamed.models.defaultModel, 'primary');
  assertEquals(renamed.modelBindings[0].key, draft.modelBindings[0].key);
  assertEquals(renamed.modelBindings.slice(1), draft.modelBindings.slice(1));
  assert(compilePlayground(renamed).ok);
  const other = updateModelBinding(renamed, draft.modelBindings[1].key, { modelId: 'secondary' });
  assertEquals(other.models.defaultModel, 'primary');
  assert(compilePlayground(other).ok);
});

Deno.test('removing the default binding clears the default and turns model select off', () => {
  const draft = createExampleDraft();
  const first = draft.modelBindings[0];
  const removed = removeModelBinding(
    { ...draft, models: { ...draft.models, defaultModel: first.modelId, allowModelSelect: true } },
    first.key,
  );
  assertEquals(removed.modelBindings, draft.modelBindings.slice(1));
  assertEquals(removed.models.defaultModel, '');
  assertEquals(removed.models.allowModelSelect, draft.modelBindings.length > 2);
  assertEquals(removeModelBinding(draft, 'missing'), draft);
});

/** A turn draft's compile; decision and host drafts have their own tests. */
function compiled(draft: PlaygroundDraft) {
  const result = compilePlayground(draft);
  if (!result.ok) throw new Error(`unexpected issues: ${JSON.stringify(result.issues)}`);
  const { profile } = result;
  if (profile.type === 'decision' || profile.type === 'host')
    throw new Error('expected a turn profile');
  return { ...result, profile };
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
  assertEquals(profile.guardrails?.egress?.checks, true);
  assertEquals(profile.guardrails?.egress?.enforce, undefined);
  assertEquals(profile.observability?.writeTo, 'playground');
});

Deno.test('egress checks compile to what differs from the bundled defaults', () => {
  const draft = createExampleDraft();
  const checks = (egressChecks: Partial<PlaygroundDraft['guardrails']['egressChecks']>) => {
    const { guardrails } = draft;
    return compiled({
      ...draft,
      guardrails: { ...guardrails, egressChecks: { ...guardrails.egressChecks, ...egressChecks } },
    }).profile.guardrails?.egress?.checks;
  };
  const { egressChecks } = draft.guardrails;
  assertEquals(checks({}), true);
  assertEquals(
    checks({
      sensitive: { ...egressChecks.sensitive, network: true },
      injection: false,
      images: { on: true, hosts: [' cdn.acme.io '], fromTools: true },
      links: { on: true, hosts: [], fromTools: false },
    }),
    {
      sensitive: { network: true },
      injection: false,
      images: { hosts: ['cdn.acme.io'] },
      links: { fromTools: false },
    },
  );
  assertEquals(checks({ links: { on: true, hosts: [], fromTools: true } }), { links: true });
  assertEquals(checks({ images: { ...egressChecks.images, on: false } }), { images: false });
  assertEquals(
    checks({
      sensitive: { ids: false, financial: false, network: false, credentials: false },
      boundary: false,
      injection: false,
      images: { ...egressChecks.images, on: false },
    }),
    false,
  );
});

Deno.test('a blank egress host is reported at its check', () => {
  const draft = createExampleDraft();
  const { guardrails } = draft;
  const result = compilePlayground({
    ...draft,
    guardrails: {
      ...guardrails,
      egressChecks: {
        ...guardrails.egressChecks,
        links: { on: true, hosts: ['docs.acme.io', ' '], fromTools: true },
      },
    },
  });
  if (result.ok) throw new Error('expected issues');
  assertEquals(
    result.issues.map(({ nodeId, field, index }) => ({ nodeId, field, index })),
    [{ nodeId: 'guardrails', field: 'egressChecks.links.hosts', index: 1 }],
  );
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

Deno.test('a thinking level the protocol does not take is an issue on that effort', () => {
  const draft = createExampleDraft();
  const [fast, ...rest] = draft.modelBindings;
  const result = compilePlayground({
    ...draft,
    modelBindings: [
      { ...fast, efforts: [fast.efforts[0], { ...fast.efforts[1], level: 'none' }] },
      ...rest,
    ],
  });
  assert(!result.ok);
  assertEquals(
    result.issues.map(({ nodeId, field, index }) => ({ nodeId, field, index })),
    [{ nodeId: modelBindingNodeId(fast.key), field: 'efforts', index: 1 }],
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

Deno.test('a Gemini Interactions binding always compiles its chaining, and storage only when set', () => {
  const draft = createExampleDraft();
  const [fast, ...rest] = draft.modelBindings;
  const model = (patch: Partial<typeof fast>) =>
    compiled({ ...draft, modelBindings: [{ ...fast, ...patch }, ...rest] }).profile.models[
      fast.modelId
    ];
  const unset = model({});
  assertEquals(unset.persistViaInteractionId, false);
  assertEquals(unset.store, undefined);
  const chained = model({ store: true, persistViaInteractionId: true });
  assertEquals([chained.store, chained.persistViaInteractionId], [true, true]);
  assertEquals(model({ store: false }).store, false);
});

Deno.test('chaining with storage off is an issue on its binding', () => {
  const draft = createExampleDraft();
  const [fast, ...rest] = draft.modelBindings;
  const result = compilePlayground({
    ...draft,
    modelBindings: [{ ...fast, store: false, persistViaInteractionId: true }, ...rest],
  });
  assertEquals(issueNodes(result), [modelBindingNodeId(fast.key)]);
  assert(!result.ok && result.issues[0].field === 'persistViaInteractionId');
});

Deno.test('chaining and storage compile only on Gemini Interactions', () => {
  const draft = createExampleDraft();
  const [fast, ...rest] = draft.modelBindings;
  const routed = {
    ...fast,
    protocol: 'openAi' as const,
    provider: 'openrouter' as const,
    apiId: OPENROUTER_PLAYGROUND_API_ID,
    store: true,
    persistViaInteractionId: true,
  };
  const model = compiled({ ...draft, modelBindings: [routed, ...rest] }).profile.models[
    fast.modelId
  ];
  assertEquals([model.store, model.persistViaInteractionId], [undefined, undefined]);
});

Deno.test('a duplicate tool name is keyed to the second tool', () => {
  const draft = createExampleDraft();
  const copy = defaultToolSpec({ toolName: draft.toolSpecs[0].toolName });
  const result = compilePlayground({ ...draft, toolSpecs: [...draft.toolSpecs, copy] });
  assertEquals(issueNodes(result), [toolSpecNodeId(copy.key)]);
});

Deno.test('setProfileType to live swaps bindings and hides facets live lacks', () => {
  const live = setProfileType(createExampleDraft(), 'live');
  assertEquals(live.modelBindings.length, 1);
  assertEquals(live.modelBindings[0].protocol, 'geminiLive');
  assertEquals(live.modelBindings[0].apiId, GEMINI_PLAYGROUND_LIVE_DEFAULT_API_ID);
  assertEquals(live.models.defaultModel, '');
  assertEquals(live.models.key, createExampleDraft().models.key);
  assertEquals(draftFacets(live).includes('outputs'), false);
  const { profile } = compiled(live);
  assertEquals(profile.type, 'live');
  assertEquals(draftFacets(setProfileType(live, 'text')).includes('outputs'), true);
});

Deno.test('live compression compiles to a sliding window, blanks left to the provider', () => {
  const live = setProfileType(createExampleDraft(), 'live');
  const on = { ...live.live, contextCompression: true };
  const bare = compiled({ ...live, live: on }).profile;
  assert(bare.type === 'live');
  assertEquals(bare.live.contextCompression, { slidingWindow: {} });
  const set = compiled({
    ...live,
    live: { ...on, compressionTriggerTokens: 52_000, compressionTargetTokens: 26_000 },
  }).profile;
  assert(set.type === 'live');
  assertEquals(set.live.contextCompression, {
    triggerTokens: 52_000,
    slidingWindow: { targetTokens: 26_000 },
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

Deno.test("compression stays within the free key's Live input tokens", () => {
  const live = setProfileType(createExampleDraft(), 'live');
  const over = GEMINI_PLAYGROUND_LIVE_INPUT_TOKENS + 1;
  const fields = (trigger: number | null, target: number | null) => {
    const result = compilePlayground({
      ...live,
      live: {
        ...live.live,
        contextCompression: true,
        compressionTriggerTokens: trigger,
        compressionTargetTokens: target,
      },
    });
    return result.ok ? [] : result.issues.map((issue) => issue.field);
  };
  assertEquals(fields(GEMINI_PLAYGROUND_LIVE_INPUT_TOKENS, null), []);
  assertEquals(fields(over, null), ['compressionTriggerTokens']);
  assertEquals(fields(null, GEMINI_PLAYGROUND_LIVE_INPUT_TOKENS), ['compressionTargetTokens']);
});

Deno.test('draftAllows reads the kernel field scope for the draft type', () => {
  const example = createExampleDraft();
  assertEquals(draftAllows(example, 'turnBehaviour.allowSteering'), true);
  assertEquals(draftAllows(setProfileType(example, 'image'), 'turnBehaviour.allowSteering'), false);
  assertEquals(draftAllows(setProfileType(example, 'live'), 'turnBehaviour.resumption'), false);
  assertEquals(draftAllows(createBlankDraft(), 'guardrails.canary'), false);
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
  assertEquals(profile.turnBehaviour, { resumption: { allowContinue: [], autoContinue: [] } });
  assertEquals(profile.lexicon, undefined);

  const live = setProfileType(image, 'live');
  const liveProfile = compiled({ ...live, tools: { t2Loader: 'not_checked' } }).profile;
  assert(liveProfile.type === 'live');
  assertEquals(Object.keys(liveProfile.tools), ['allow']);
});

Deno.test('continuing set to Never compiles to an empty allow list, not the kernel default', () => {
  const text = includeFacet(createExampleDraft(), 'turnBehaviour');
  const never = compiled({
    ...text,
    turnBehaviour: { ...text.turnBehaviour, resumeEnabled: false },
  });
  assertEquals(never.profile.turnBehaviour, { resumption: { allowContinue: [] } });
  const some = compiled({
    ...text,
    turnBehaviour: {
      ...text.turnBehaviour,
      resumeEnabled: true,
      allowContinue: ['length'],
      autoContinue: ['length'],
    },
  });
  assertEquals(some.profile.turnBehaviour, {
    resumption: { allowContinue: ['length'], autoContinue: ['length'] },
  });
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

Deno.test('Wording compiles into the profile lexicon; lines edited beside their setting come from there', () => {
  const draft = {
    ...createExampleDraft(),
    wording: {
      'error.rate_limit': ' Busy, try again soon. ',
      'error.timeout': '  ',
      'quota.exhausted': 'Ignored.',
    },
  };
  assertEquals(compiled(draft).profile.lexicon, { 'error.rate_limit': 'Busy, try again soon.' });
  assertEquals(compiled(excludeFacet(draft, 'wording')).profile.lexicon, undefined);
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
  assertEquals(withGuardrails.included, ['observability', 'wording', 'guardrails']);
  assertEquals(excludeFacet(withGuardrails, 'guardrails').included, ['observability', 'wording']);
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
    [
      'models',
      'tools',
      'inputs',
      'outputs',
      'turnBehaviour',
      'guardrails',
      'observability',
      'wording',
    ],
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
  assert(!source.includes('standardEgressEnforce'));
  assertStringIncludes(source, 'checks: true,');
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
  assert(isKeySlotName(draft.models.key));
  assertEquals(draft.included, ['observability', 'wording']);
  assertEquals(draft.observability.writeTo, 'playground');
});

Deno.test('a new image profile starts on the playground Gemini image model', () => {
  const draft = setProfileType(createBlankDraft(), 'image');
  assertEquals(draft.modelBindings[0].provider, 'google');
  assertEquals(draft.modelBindings[0].apiId, GEMINI_PLAYGROUND_IMAGE_DEFAULT_API_ID);
  assert(isKeySlotName(draft.models.key));
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

Deno.test('zodFromJsonSchema keeps a text answer as text and a nullable field nullable', () => {
  assertEquals(zodFromJsonSchema({ type: 'string' }).parse('docs'), 'docs');
  const schema = zodFromJsonSchema({
    type: 'object',
    properties: { content: { type: ['string', 'null'] } },
    required: ['content'],
  });
  assertEquals(schema.parse({ content: null }), { content: null });
  assert(!schema.safeParse({ content: 1 }).success);
});

Deno.test('quoteSource writes a string that evaluates back to itself, script-safe', () => {
  const text = `it's "quoted" \\ </script> \u2028\u2029 done`;
  const quoted = quoteSource(text);
  assertEquals(new Function(`return ${quoted};`)(), text);
  assertEquals(/[<>\u2028\u2029]/.test(quoted), false);
});

Deno.test('redactSensitive compiles to the groups the draft changes, false when none are on', () => {
  const draft = includeFacet(createExampleDraft(), 'guardrails');
  const groups = { ids: true, financial: true, network: true, credentials: true };
  const redact = (redactSensitive: typeof groups) =>
    compiled({ ...draft, guardrails: { ...draft.guardrails, redactSensitive } }).profile.guardrails
      ?.redactSensitive;
  assertEquals(redact(groups), undefined);
  assertEquals(redact({ ...groups, network: false }), { network: false });
  assertEquals(redact({ ids: false, financial: false, network: false, credentials: false }), false);
});

Deno.test('a host draft compiles to its tools, with no model or identity', () => {
  const host = setProfileType(createExampleDraft(), 'host');
  const result = compilePlayground(host);
  if (!result.ok) throw new Error(`unexpected issues: ${JSON.stringify(result.issues)}`);
  const { profile } = result;
  assertEquals(profile.type, 'host');
  assert(!('models' in profile));
  assert(!('identity' in profile));
  assertEquals(result.customTools.length, demoToolSpecs().length);
  assert(profile.type === 'host' && profile.tools?.allow?.includes('get_weather'));
});

Deno.test('a host draft switches back to text with its tools', () => {
  const text = setProfileType(setProfileType(createExampleDraft(), 'host'), 'text');
  const { profile } = compiled(text);
  assertEquals(profile.type, 'text');
  assert(profile.type === 'text' && profile.tools?.allow?.includes('get_weather'));
});

Deno.test('a header that looks like a credential is refused; Auth holds secrets', () => {
  const draft = createExampleDraft();
  const geocode = draft.toolSpecs.find((tool) => tool.toolName === 'geocode_city');
  assert(geocode);
  const withHeaders = (headers: Record<string, string>) =>
    compilePlayground({
      ...draft,
      toolSpecs: draft.toolSpecs.map((tool) =>
        tool.key === geocode.key ? { ...tool, headersJson: JSON.stringify(headers) } : tool,
      ),
    });
  for (const name of ['Authorization', 'X-API-Key', 'Cookie', 'X-Access-Token', 'Mcp-Session-Id']) {
    const result = withHeaders({ [name]: 'value' });
    assert(!result.ok, name);
    assertEquals(result.issues[0].field, 'headersJson');
    assertStringIncludes(result.issues[0].message, `${name} looks like a credential`);
  }
  assert(withHeaders({ 'User-Agent': 'demo', Accept: 'application/json' }).ok);
});

Deno.test('a tool compiles its activity labels, each placeholder checked against its schemas', () => {
  const draft = createExampleDraft();
  const geocode = draft.toolSpecs.find((tool) => tool.toolName === 'geocode_city');
  assert(geocode);
  const withLabels = (activity: string, activityPast: string) =>
    compilePlayground({
      ...draft,
      toolSpecs: draft.toolSpecs.map((tool) =>
        tool.key === geocode.key ? { ...tool, activity, activityPast } : tool,
      ),
    });
  const ok = withLabels('Finding {name}', 'Found {results.0.name}, {results.0.country_code}');
  assert(ok.ok);
  assertEquals(ok.customTools.find((tool) => tool.name === 'geocode_city')?.labels, {
    activity: 'Finding {name}',
    activityPast: 'Found {results.0.name}, {results.0.country_code}',
  });
  const issue = (activity: string, activityPast: string) => {
    const result = withLabels(activity, activityPast);
    assert(!result.ok);
    return { field: result.issues[0].field, message: result.issues[0].message };
  };
  assertEquals(issue('Finding {results.0.name}', 'Found it'), {
    field: 'activity',
    message: "{results.0.name} is not a field of this tool's input. Try {name}.",
  });
  assertEquals(issue('Finding {name}', 'Found {results.first.name}'), {
    field: 'activityPast',
    message:
      "{results.first.name} is not a field of this tool's input or output. " +
      'Try {results.0.name}, {results.0.latitude}, {results.0.longitude} or {results.0.country_code}.',
  });
  assertEquals(issue('Finding {name}', 'Found {results}'), {
    field: 'activityPast',
    message:
      '{results} is a list or group; a label shows text or a number. ' +
      'Try {results.0.name}, {results.0.latitude}, {results.0.longitude} or {results.0.country_code}.',
  });
  assertEquals(
    issue('Finding { }', 'Found it').message,
    'Put a field name between the braces, like {name}.',
  );
  assertEquals(
    issue('Finding {output.results.0.name}', 'Found it').message,
    '{output.results.0.name} is only there once the call is done; use it in the Done label.',
  );
  assertEquals(
    issue('Finding {name}', 'Found {output.name}').message,
    "{output.name} is not a field of this tool's output. Try {output.results.0.name}, " +
      '{output.results.0.latitude}, {output.results.0.longitude} or {output.results.0.country_code}.',
  );
  assert(withLabels('Finding {{name}}', 'Found {results.length}, first {results.-1.name|none}').ok);
  assertEquals(issue(`Finding ${'x'.repeat(121)}`, 'Found it').field, 'activity');
});

Deno.test('an activity label follows nullable, union and referenced schemas', () => {
  const draft = createExampleDraft();
  const geocode = draft.toolSpecs.find((tool) => tool.toolName === 'geocode_city');
  assert(geocode);
  const compile = (output: unknown, activityPast: string) =>
    compilePlayground({
      ...draft,
      toolSpecs: draft.toolSpecs.map((tool) =>
        tool.key === geocode.key
          ? { ...tool, outputJson: JSON.stringify(output), activityPast }
          : tool,
      ),
    });
  const place = { type: 'object', properties: { name: { type: 'string' } } };
  const nullable = { type: ['array', 'null'], items: place };
  assert(compile({ type: 'object', properties: { r: nullable } }, 'Found {r.0.name}').ok);
  const union = { anyOf: [place, { type: 'null' }] };
  assert(compile({ type: 'object', properties: { p: union } }, 'Found {p.name}').ok);
  const referenced = { $ref: '#/$defs/place' };
  assert(compile({ type: 'object', properties: { p: referenced } }, 'Found {p.name}').ok);
  const flag = compile({ type: 'object', properties: { ok: { type: 'boolean' } } }, 'Done: {ok}');
  assert(!flag.ok);
  assertEquals(flag.issues[0].message, '{ok} is true or false; a label shows text or a number.');
});

Deno.test('an image draft pins references and output settings, and reports what it cannot send', () => {
  const draft = setProfileType(createExampleDraft(), 'image');
  const pinned = compiled({
    ...draft,
    image: {
      ...draft.image,
      quality: ' high ',
      seed: 7,
      references: [
        { key: 'reference-a', name: 'a.png', mimeType: 'image/png', data: 'AAAA' },
        { key: 'reference-b', uri: 'https://example.com/b.JPG?v=1' },
      ],
    },
  }).profile;
  assert(pinned.type === 'image');
  assertEquals(pinned.image, {
    quality: 'high',
    seed: 7,
    references: [
      { mimeType: 'image/png', data: 'AAAA', name: 'a.png' },
      { mimeType: 'image/jpeg', uri: 'https://example.com/b.JPG?v=1' },
    ],
  });

  const refused = compilePlayground({
    ...draft,
    image: {
      ...draft.image,
      n: 0,
      outputCompression: 101,
      references: [
        { key: 'reference-a', name: 'a.pdf', mimeType: 'application/pdf', data: 'AAAA' },
        { key: 'reference-b', uri: 'ftp://example.com/b.png' },
        { key: 'reference-c', uri: '' },
      ],
    },
  });
  assert(!refused.ok);
  assertEquals(
    refused.issues.map(({ nodeId, field, index }) => ({ nodeId, field, index })),
    [
      { nodeId: 'image', field: 'n', index: undefined },
      { nodeId: 'image', field: 'outputCompression', index: undefined },
      { nodeId: 'image', field: 'references', index: 0 },
      { nodeId: 'image', field: 'references', index: 1 },
      { nodeId: 'image', field: 'references', index: 2 },
    ],
  );
});

Deno.test('instructions by role, slots and limits by type compile from their JSON fields', () => {
  const draft = createExampleDraft();
  const { profile } = compiled({
    ...draft,
    identity: { ...draft.identity, systemByRoleJson: '{"support":"Answer as support."}' },
    inputs: {
      ...draft.inputs,
      limitsByMimeJson: '{"application/pdf":2000000}',
      slotsJson: '{"language":["en","fr"]}',
    },
  });
  assert(profile.type === 'text');
  assertEquals(profile.identity.systemByRole, { support: 'Answer as support.' });
  assertEquals(profile.inputs?.limitsByMime, { 'application/pdf': 2000000 });
  assertEquals(profile.inputs?.slots, { language: ['en', 'fr'] });

  const bad = compilePlayground({
    ...draft,
    identity: { ...draft.identity, systemByRoleJson: '{"support":1}' },
    inputs: { ...draft.inputs, limitsByMimeJson: '{"image/*":0}', slotsJson: '{"language":[]}' },
  });
  assert(!bad.ok);
  assertEquals(bad.issues.map((issue) => issue.field).sort(), [
    'limitsByMimeJson',
    'slotsJson',
    'systemByRoleJson',
  ]);
});

Deno.test('prompt caching compiles on OpenRouter and is refused elsewhere', () => {
  const draft = createExampleDraft();
  const withCache = (index: number) =>
    updateModelBinding(draft, draft.modelBindings[index].key, {
      cacheMode: 'system',
      cacheTtl: '1h',
    });
  const { profile } = compiled(withCache(2));
  assertEquals(profile.models.open.cache, { mode: 'system', ttl: '1h' });
  assertEquals(profile.models.fast.cache, undefined);
  const refused = compilePlayground(withCache(0));
  assert(!refused.ok);
  assertEquals(
    refused.issues.map((issue) => issue.field),
    ['cacheMode'],
  );
});

Deno.test('a local server name compiles only on a local model', () => {
  const draft = createExampleDraft();
  const { profile } = compiled(
    updateModelBinding(draft, draft.modelBindings[2].key, { server: 'ollama' }),
  );
  assertEquals(profile.models.open.server, undefined);
});

Deno.test('prompt echo, schemes, taint and trace resource compile when set', () => {
  const draft = createExampleDraft();
  const { profile } = compiled({
    ...draft,
    guardrails: {
      ...draft.guardrails,
      promptEcho: false,
      allowedSchemes: ['https', ' '],
      taintAfterRemoteRead: 'write',
    },
    observability: { ...draft.observability, resourceJson: '{"service.name":"concierge"}' },
  });
  assertEquals(profile.guardrails?.promptEcho, false);
  assertEquals(profile.guardrails?.network?.allowedSchemes, ['https']);
  assertEquals(profile.guardrails?.taint, { afterRemoteRead: 'write' });
  assertEquals(profile.observability?.resource, { 'service.name': 'concierge' });

  const plain = compiled(draft).profile;
  assertEquals(plain.guardrails?.promptEcho, undefined);
  assertEquals(plain.guardrails?.taint, undefined);
  assertEquals(plain.observability?.resource, undefined);

  const bad = compilePlayground({
    ...draft,
    observability: { ...draft.observability, resourceJson: '[1]' },
  });
  assert(!bad.ok);
  assertEquals(
    bad.issues.map((issue) => issue.field),
    ['resourceJson'],
  );
});
