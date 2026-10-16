import '../fixtures/test-host.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  defineProfile,
  defineProvider,
  geminiProvider,
  memorySink,
  openAi,
  type Provider,
} from '../../mod.ts';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import {
  compileStudio,
  createBlankDraft,
  createExampleDraft,
  createGeminiEmbeddingExampleDraft,
  createLiveExampleDraft,
  lentCompression,
  setProfileType,
} from '../../studio/mod.ts';
import {
  runtimeProvider,
  type StudioRuntime,
  studioNetworkNote,
  studioScope,
  studioTaintNote,
} from '../../studio/runtime-scope.ts';
import { ON_TEST_KEYS, TEST_KEYS } from '../fixtures/lent-keys.ts';

function afterRemoteRead(guardrails: object | undefined): unknown {
  return guardrails && 'taint' in guardrails
    ? (guardrails.taint as { afterRemoteRead?: string } | undefined)?.afterRemoteRead
    : undefined;
}

function compiledExample(edit: (draft: ReturnType<typeof createExampleDraft>) => void = () => {}) {
  const draft = createExampleDraft();
  draft.guardrails.allowPrivateNetworks = true;
  edit(draft);
  const compiled = compileStudio(draft, ON_OWN_KEYS);
  assert(compiled.ok, JSON.stringify(!compiled.ok && compiled.issues));
  return compiled;
}

async function runOn(runtime: StudioRuntime, compiled = compiledExample()) {
  const { profile } = await studioScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    runtime,
  );
  return { guardrails: profile.guardrails, note: studioNetworkNote(runtime) };
}

Deno.test("on the builder's own keys a profile runs with the guardrails it was given", async () => {
  const compiled = compiledExample((draft) => {
    draft.guardrails.taintAfterRemoteRead = '';
  });
  const own = await runOn(ON_OWN_KEYS, compiled);
  assertEquals(own.guardrails, defineProfile(compiled.profile).guardrails);
  assertEquals(own.note, undefined);
  assertEquals(studioTaintNote(ON_OWN_KEYS), undefined);
});

Deno.test("the Network note says what the studio's runtime does with the rules", async () => {
  const lent = await runOn(ON_TEST_KEYS);
  assertEquals(lent.guardrails?.network, undefined);
  assertEquals(lent.note, "This page's keys reach public hosts only.");

  const unheld = {
    mode: 'demo',
    keys: { ...TEST_KEYS, holds: { ...TEST_KEYS.holds, publicHostsOnly: false } },
  } as const;
  assertEquals((await runOn(unheld)).guardrails?.network?.allowPrivateNetworks, true);
  assertEquals(studioNetworkNote(unheld), undefined);

  const local = { baseUrl: 'http://127.0.0.1:11434' };
  const offline = await runOn({ mode: 'byok', providers: { local }, remoteTools: false });
  assertEquals(offline.guardrails?.network, { allowedSchemes: [] });
  assertEquals(offline.note, 'Remote tools off: no host reached.');

  const online = await runOn({ mode: 'byok', providers: { local }, remoteTools: true });
  assertEquals(online.guardrails?.network?.allowPrivateNetworks, true);
  assertEquals(online.note, undefined);
});

Deno.test('lent keys refuse what they hold after a remote read, and a stricter profile keeps its own', async () => {
  const unset = compiledExample((draft) => {
    draft.guardrails.taintAfterRemoteRead = '';
  });
  assertEquals(afterRemoteRead((await runOn(ON_TEST_KEYS, unset)).guardrails), 'destructive');
  assertEquals(
    studioTaintNote(ON_TEST_KEYS),
    "This page's keys refuse destructive calls after a remote read. Stricter settings hold.",
  );

  const stricter = compiledExample((draft) => {
    draft.guardrails.taintAfterRemoteRead = 'write';
  });
  assertEquals(afterRemoteRead((await runOn(ON_TEST_KEYS, stricter)).guardrails), 'write');

  const open = {
    mode: 'demo',
    keys: { ...TEST_KEYS, holds: { ...TEST_KEYS.holds, afterRemoteRead: 'off' } },
  } as const;
  assertEquals(afterRemoteRead((await runOn(open, unset)).guardrails), undefined);
  assertEquals(studioTaintNote(open), undefined);
});

Deno.test('on lent keys, a profile that calls no tools runs with the guardrails it was written with', async () => {
  const blank = setProfileType(createBlankDraft(), 'speech', TEST_KEYS);
  const speech = {
    ...blank,
    identity: { ...blank.identity, agentId: 'held.speech', handle: 'speech' },
  };
  for (const draft of [speech, createGeminiEmbeddingExampleDraft()]) {
    const compiled = compileStudio(draft, ON_TEST_KEYS);
    assert(compiled.ok, JSON.stringify(!compiled.ok && compiled.issues));
    const { profile } = await studioScope(compiled.profile, [], undefined, ON_TEST_KEYS);
    assertEquals(afterRemoteRead(profile.guardrails), undefined);
  }
});

Deno.test('a Live session on lent keys compresses where the editor shows, and as written on own keys', async () => {
  const draft = createLiveExampleDraft();
  draft.live = {
    ...draft.live,
    contextCompression: true,
    compressionTriggerTokens: null,
    compressionTargetTokens: null,
  };
  const compiled = compileStudio(draft, ON_OWN_KEYS);
  assert(compiled.ok, JSON.stringify(!compiled.ok && compiled.issues));
  const compression = async (runtime: StudioRuntime) => {
    const { profile } = await studioScope(
      compiled.profile,
      compiled.customTools,
      compiled.structured,
      runtime,
    );
    return profile.type === 'live' ? profile.live.contextCompression : undefined;
  };
  const shown = lentCompression(TEST_KEYS, {});
  assertEquals(shown, { triggerTokens: 52_429, targetTokens: 26_215 });
  assertEquals(await compression(ON_TEST_KEYS), {
    triggerTokens: shown.triggerTokens,
    slidingWindow: { targetTokens: shown.targetTokens },
  });
  assertEquals(await compression(ON_OWN_KEYS), { slidingWindow: {} });
  assertEquals(lentCompression(TEST_KEYS, { triggerTokens: 20_000 }).targetTokens, 10_000);
});

Deno.test('Studio compiled profiles run on a scripted model in their isolated scope', async () => {
  const compiled = compileStudio(createExampleDraft(), ON_OWN_KEYS);
  assert(compiled.ok);
  const runtime: StudioRuntime = {
    ...ON_TEST_KEYS,
    provider: () => ({
      async *complete() {
        yield { type: 'text', text: 'studio scripted reply' };
        yield { type: 'done', stop: { kind: 'completed' } };
      },
    }),
  };
  const { scope, profile } = await studioScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    runtime,
  );
  if (profile.type !== 'text') throw new Error('Expected a text profile');
  const options = runtimeProvider(runtime, scope, profile);
  const ran = scope.profiles.get(profile.id);
  assert(ran.type === 'text');
  const binding = ran.models[ran.defaultModel];
  const scripted = scope.providers.require(binding.provider, binding.apiId);
  assert(binding.provider !== profile.models[profile.defaultModel].provider);
  assertEquals(
    scripted.serves.map((serve) => serve.protocol.id),
    [binding.protocol],
  );
  const events = await Array.fromAsync(
    scope.runTurn({ profile: profile.id, input: { text: 'hello' } }, options, memorySink([])),
  );
  assertEquals(
    events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'studio scripted reply',
  );
});

Deno.test('Studio runtime vault does not resolve inherited credentials', async () => {
  const compiled = compileStudio(createExampleDraft(), ON_OWN_KEYS);
  assert(compiled.ok);
  const { scope, profile } = await studioScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    ON_TEST_KEYS,
  );
  if (profile.type !== 'text') throw new Error('Expected a text profile');
  const binding = profile.models[profile.defaultModel];
  assertEquals(binding.provider, 'gemini');
  const slot = binding.keySlot ?? 'identity';
  scope.providers.replace(geminiProvider, { id: binding.provider, keySlot: slot });
  let resolved = 0;
  let fetched = 0;
  await assertRejects(
    () =>
      Array.fromAsync(
        scope.runTurn(
          { profile: profile.id, input: { text: 'hello' } },
          {
            fetch: () => {
              fetched++;
              return Promise.resolve(new Response('{}'));
            },
            vault: Object.create({
              [slot]: () => {
                resolved++;
                return 'inherited-secret';
              },
            }),
          },
          memorySink([]),
        ),
      ),
    Error,
    slot,
  );
  assertEquals(resolved, 0);
  assertEquals(fetched, 0);
});

Deno.test('host authoring runtime registers external providers before plain-data profiles', async () => {
  const provider = defineProvider({
    id: 'company-endpoint',
    name: 'Company endpoint',
    description: "The company's own Chat Completions endpoint.",
    serves: () => [{ protocol: openAi, baseUrl: 'https://fixture.test/v1' }],
  }) as Provider;
  const definition = {
    id: 'external-authoring',
    type: 'text' as const,
    identity: { handle: 'External' },
    models: {
      default: {
        protocol: 'openAi',
        provider: provider.id,
        apiId: 'company-model',
        summaries: false,
      },
    },
    inputs: { text: true },
    tools: { allow: [] },
  };
  const runtime: StudioRuntime = { mode: 'byok', providerDefinitions: [provider] };
  const { scope, profile } = await studioScope(definition, [], undefined, runtime);
  const registered = scope.providers.require(provider.id, 'company-model');
  assertEquals(registered.definition, provider);
  assertEquals(
    registered.serves.map((serve) => serve.protocol.id),
    ['openAi'],
  );
  assertEquals(profile.type === 'text' && profile.models.default.provider, provider.id);
  const urls: string[] = [];
  const events = await Array.fromAsync(
    scope.runTurn(
      { profile: profile.id, input: { text: 'hello' } },
      {
        fetch: (input) => {
          urls.push(input instanceof Request ? input.url : String(input));
          return Promise.resolve(
            new Response(
              'data: {"choices":[{"delta":{"content":"external"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            ),
          );
        },
      },
    ),
  );
  assertEquals(urls, ['https://fixture.test/v1/chat/completions']);
  assert(events.some((event) => event.type === 'text' && event.text === 'external'));
});
