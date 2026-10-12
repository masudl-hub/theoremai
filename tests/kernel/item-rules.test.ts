import { createTestKernelScope } from '../fixtures/provider-scope.ts';
import { runScopedTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import type {
  ModelProvider,
  ProfileItemRule,
  ProviderCompleteRequest,
  TurnEvent,
  TurnEventOf,
} from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const CLAIM = {
  type: 'object',
  properties: { claim: { type: 'string' }, source: { type: 'string' } },
  required: ['claim'],
};
const REPLY = {
  type: 'object',
  properties: { summary: { type: 'string' }, claims: { type: 'array', items: CLAIM } },
  required: ['summary', 'claims'],
};

const cited: ProfileItemRule['check'] = (item) =>
  typeof item === 'object' && item !== null && 'source' in item
    ? { isValid: true }
    : { isValid: false, error: 'a claim needs a source' };

/** A scope with one profile whose `claims` items must be cited. */
function scopeWith(
  onFail: ProfileItemRule['onFail'],
  maxRetries = 1,
  lexicon?: Record<string, string>,
): KernelScope {
  const scope = createTestKernelScope();
  scope.schemas.register('item_rules_reply', { jsonSchema: REPLY });
  scope.profiles.register(
    defineProfile({
      type: 'text',
      id: 'item_rules',
      identity: { handle: 'item rules' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: [] },
      inputs: { text: true },
      outputs: {
        structured: 'item_rules_reply',
        validation: { items: { claims: { check: cited, onFail } }, maxRetries },
      },
      ...(lexicon ? { lexicon } : {}),
    }),
  );
  return scope;
}

const FIRST = {
  summary: 'water less',
  claims: [{ claim: 'kept', source: 'a' }, { claim: 'bare' }, { claim: 'last', source: 'c' }],
};

/** Answers the first call with `FIRST` and each later call with the next of `rewrites`. */
function provider(rewrites: unknown[], seen: ProviderCompleteRequest[] = []): ModelProvider {
  return {
    async *complete(req) {
      await Promise.resolve();
      seen.push(req);
      const reply = seen.length === 1 ? FIRST : rewrites[seen.length - 2];
      yield { type: 'text', text: JSON.stringify(reply) };
      yield { type: 'structured', structured: reply };
    },
  };
}

async function reply(scope: KernelScope, model: ModelProvider): Promise<TurnEventOf<'structured'>> {
  const events: TurnEvent[] = [];
  for await (const event of runScopedTurn(
    scope,
    { profile: 'item_rules', input: { text: 'Help' } },
    model,
  )) {
    events.push(event);
  }
  const structured = events.filter((e): e is TurnEventOf<'structured'> => e.type === 'structured');
  assertEquals(structured.length, 1);
  return structured[0] as TurnEventOf<'structured'>;
}

Deno.test('drop removes a refused item, keeps the rest and makes no second call', async () => {
  const seen: ProviderCompleteRequest[] = [];
  const event = await reply(scopeWith('drop'), provider([], seen));
  assertEquals(seen.length, 1);
  assertEquals(event.structured, {
    summary: 'water less',
    claims: [
      { claim: 'kept', source: 'a' },
      { claim: 'last', source: 'c' },
    ],
  });
  assertEquals(event.removed, [
    { path: 'claims', reason: 'a claim needs a source', item: { claim: 'bare' } },
  ]);
});

Deno.test('fix asks for the refused item alone and puts its rewrite back in place', async () => {
  const seen: ProviderCompleteRequest[] = [];
  const event = await reply(
    scopeWith('fix'),
    provider([{ claims: [{ claim: 'bare', source: 'b' }] }], seen),
  );
  assertEquals(seen.length, 2);
  // The rewrite answers under a schema that holds only the list, and reads only the refused item.
  assertEquals(seen[1]?.structured?.jsonSchema, {
    type: 'object',
    properties: { claims: { type: 'array', items: CLAIM } },
    required: ['claims'],
  });
  const asked = String(seen[1]?.history?.at(-1)?.content);
  assertEquals(asked.includes('"claim":"bare"'), true);
  assertEquals(asked.includes('"claim":"kept"'), false);
  assertEquals(asked.includes('claims[0]: a claim needs a source'), true);
  assertEquals(event.structured, {
    summary: 'water less',
    claims: [
      { claim: 'kept', source: 'a' },
      { claim: 'bare', source: 'b' },
      { claim: 'last', source: 'c' },
    ],
  });
  assertEquals(event.removed, undefined);
});

Deno.test("the rewrite's guidance is the profile's own line when it sets one", async () => {
  const seen: ProviderCompleteRequest[] = [];
  await reply(
    scopeWith('fix', 1, { 'repair.items_guidance': 'Cite these or leave them out.' }),
    provider([{ claims: [{ claim: 'bare', source: 'b' }] }], seen),
  );
  const asked = String(seen[1]?.history?.at(-1)?.content);
  assertEquals(asked.includes('Cite these or leave them out.'), true);
  assertEquals(asked.includes('the rest of your reply is kept'), false);
});

Deno.test('an item refused again after its one rewrite is removed', async () => {
  const seen: ProviderCompleteRequest[] = [];
  const event = await reply(
    scopeWith('fix', 3),
    provider([{ claims: [{ claim: 'still bare' }] }], seen),
  );
  assertEquals(seen.length, 2);
  assertEquals(event.structured, {
    summary: 'water less',
    claims: [
      { claim: 'kept', source: 'a' },
      { claim: 'last', source: 'c' },
    ],
  });
  assertEquals(event.removed, [
    { path: 'claims', reason: 'a claim needs a source', item: { claim: 'still bare' } },
  ]);
});

Deno.test('fix with no retries left removes the item', async () => {
  const seen: ProviderCompleteRequest[] = [];
  const event = await reply(scopeWith('fix', 0), provider([], seen));
  assertEquals(seen.length, 1);
  assertEquals(event.removed?.length, 1);
});

Deno.test('an item rule on a path that is not a list is refused at registration', () => {
  const scope = createTestKernelScope();
  scope.schemas.register('item_rules_reply', { jsonSchema: REPLY });
  assertThrows(
    () =>
      scope.profiles.register(
        defineProfile({
          type: 'text',
          id: 'item_rules',
          identity: { handle: 'item rules' },
          ...geminiModels('gemini35FlashLite'),
          maxSteps: 2,
          tools: { allow: [] },
          inputs: { text: true },
          outputs: {
            structured: 'item_rules_reply',
            validation: { items: { summary: { check: cited, onFail: 'drop' } } },
          },
        }),
      ),
    TheoremError,
    'outputs.validation.items has summary',
  );
});

Deno.test('an agent tool returns what the called agent removed', async () => {
  const scope = scopeWith('drop');
  scope.tools.register({
    type: 'agent',
    name: 'ask',
    description: 'Ask.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    profile: 'item_rules',
  });
  scope.profiles.register(
    defineProfile({
      type: 'text',
      id: 'item_rules_caller',
      identity: { handle: 'caller', system: 'CALLER' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 3,
      tools: { allow: ['ask'] },
      inputs: { text: true },
    }),
  );
  let callerStep = 0;
  const model: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      if (!req.system.includes('CALLER')) {
        yield { type: 'structured', structured: FIRST };
        return;
      }
      callerStep += 1;
      if (callerStep === 1) {
        yield { type: 'tool', tool: { name: 'ask', arguments: { text: 'q' }, callId: 'c1' } };
        return;
      }
      yield { type: 'text', text: 'Done.' };
    },
  };
  const events: TurnEvent[] = [];
  for await (const event of runScopedTurn(
    scope,
    { profile: 'item_rules_caller', input: { text: 'Help' } },
    model,
  )) {
    events.push(event);
  }
  const complete = events.flatMap((e) =>
    e.type === 'tool' && 'phase' in e.tool && e.tool.phase === 'complete' ? [e.tool.output] : [],
  );
  assertEquals(complete, [
    {
      structured: {
        summary: 'water less',
        claims: [
          { claim: 'kept', source: 'a' },
          { claim: 'last', source: 'c' },
        ],
      },
      removed: [{ path: 'claims', reason: 'a claim needs a source', item: { claim: 'bare' } }],
    },
  ]);
});
