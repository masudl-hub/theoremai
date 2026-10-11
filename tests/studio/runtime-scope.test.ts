import '../fixtures/test-host.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { defineProvider, memorySink, openAIChat } from '../../mod.ts';
import { compileStudio, createExampleDraft } from '../../studio/mod.ts';
import {
  STUDIO_TAINT_NOTE,
  type StudioRuntime,
  studioNetworkNote,
  studioScope,
} from '../../studio/runtime-scope.ts';
import { PrototypeAdapter } from '../fixtures/prototype-adapter.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

function afterRemoteRead(guardrails: object | undefined): unknown {
  return guardrails && 'taint' in guardrails
    ? (guardrails.taint as { afterRemoteRead?: string } | undefined)?.afterRemoteRead
    : undefined;
}

async function runOn(runtime: StudioRuntime) {
  const draft = createExampleDraft();
  draft.guardrails.allowPrivateNetworks = true;
  const compiled = compileStudio(draft);
  assert(compiled.ok, JSON.stringify(!compiled.ok && compiled.issues));
  const { profile } = await studioScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    runtime,
  );
  return { guardrails: profile.guardrails, note: studioNetworkNote(runtime) };
}

Deno.test("the Network note says what the studio's runtime does with the rules", async () => {
  const demo = await runOn({ mode: 'demo' });
  assertEquals(demo.guardrails?.network, undefined);
  assertEquals(demo.note, 'Studio server: public hosts only.');

  const browser = await runOn({ mode: 'byok' });
  assertEquals(browser.guardrails?.network?.allowPrivateNetworks, true);
  assertEquals(browser.note, 'Browser runs: rules as written.');

  const local = { baseUrl: 'http://127.0.0.1:11434' };
  const offline = await runOn({ mode: 'byok', providers: { local }, remoteTools: false });
  assertEquals(offline.guardrails?.network, { allowedSchemes: [] });
  assertEquals(offline.note, 'Remote tools off: no host reached.');

  const online = await runOn({ mode: 'byok', providers: { local }, remoteTools: true });
  assertEquals(online.guardrails?.network?.allowPrivateNetworks, true);
  assertEquals(online.note, browser.note);
});

Deno.test('the Taint note says studio runs refuse destructive calls after a remote read', async () => {
  assertEquals(afterRemoteRead((await runOn({ mode: 'demo' })).guardrails), 'destructive');
  assert(STUDIO_TAINT_NOTE.includes('refuse destructive calls'));

  const draft = createExampleDraft();
  draft.guardrails.taintAfterRemoteRead = 'write';
  const compiled = compileStudio(draft);
  assert(compiled.ok);
  const { profile } = await studioScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    {
      mode: 'demo',
    },
  );
  assertEquals(afterRemoteRead(profile.guardrails), 'write');
  assert(STUDIO_TAINT_NOTE.includes('Stricter settings hold'));
});

Deno.test('Studio compiled profiles run through a class adapter in their isolated scope', async () => {
  const compiled = compileStudio(createExampleDraft());
  assert(compiled.ok);
  const { scope, profile } = await studioScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    { mode: 'demo' },
  );
  if (profile.type !== 'text') throw new Error('Expected a text profile');
  const options = fixtureHostOptions(
    {
      async *complete() {
        yield { type: 'text', text: 'studio class reply' };
        yield { type: 'done', stop: { kind: 'completed' } };
      },
    },
    scope,
  );
  const id = profile.models[profile.defaultModel].provider;
  const registered = scope.providers.require(id);
  scope.providers.register({ ...registered, adapter: new PrototypeAdapter(registered.adapter) });
  const events = await Array.fromAsync(
    scope.runTurn(
      {
        profile: profile.id,
        input: { text: 'hello' },
      },
      options,
      memorySink([]),
    ),
  );
  assertEquals(
    events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'studio class reply',
  );
});

Deno.test('Studio runtime vault does not resolve inherited credentials', async () => {
  const compiled = compileStudio(createExampleDraft());
  assert(compiled.ok);
  const { scope, profile } = await studioScope(
    compiled.profile,
    compiled.customTools,
    compiled.structured,
    { mode: 'demo' },
  );
  if (profile.type !== 'text') throw new Error('Expected a text profile');
  let resolved = 0;
  let completed = 0;
  const options = fixtureHostOptions(
    {
      async *complete() {
        completed++;
        yield { type: 'done', stop: { kind: 'completed' } };
      },
    },
    scope,
  );
  const registered = scope.providers.require(profile.models[profile.defaultModel].provider);
  const slot = profile.models[profile.defaultModel].keySlot ?? 'identity';
  scope.providers.register({
    ...registered,
    keySlot: slot,
    adapter: {
      ...registered.adapter,
      async create(context) {
        await context.resolveCredential('primary');
        return await registered.adapter.create(context);
      },
    },
  });
  await assertRejects(
    () =>
      Array.fromAsync(
        scope.runTurn(
          { profile: profile.id, input: { text: 'hello' } },
          {
            ...options,
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
  assertEquals(completed, 0);
});

Deno.test('host authoring runtime registers external providers before plain-data profiles', async () => {
  const provider = defineProvider({
    id: 'company-endpoint',
    connection: { baseURL: 'https://fixture.test/v1' },
    adapter: openAIChat(),
  });
  const definition = {
    id: 'external-authoring',
    type: 'text' as const,
    identity: { handle: 'External' },
    models: { default: provider.model('company-model', { summaries: false }) },
    inputs: { text: true },
    tools: { allow: [] },
  };
  const runtime: StudioRuntime = { mode: 'byok', providerDefinitions: [provider] };
  const { scope, profile } = await studioScope(definition, [], undefined, runtime);
  assertEquals(scope.providers.require(provider.id).adapter.id, 'openai-chat');
  assertEquals(profile.type === 'text' && profile.models.default.provider, provider.id);
  const events = await Array.fromAsync(
    scope.runTurn(
      { profile: profile.id, input: { text: 'hello' } },
      {
        fetch: () =>
          Promise.resolve(
            new Response(
              'data: {"choices":[{"delta":{"content":"external"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            ),
          ),
      },
    ),
  );
  assert(events.some((event) => event.type === 'text' && event.text === 'external'));
});
