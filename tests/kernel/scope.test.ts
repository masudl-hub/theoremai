import '../fixtures/test-host.ts';
import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import { hasProfile, hasTool, runTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertRejects } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { createKernelScope, type KernelScope } from '../../src/kernel/scope.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';

const PROFILE = 'scope_isolation_bot';
const TOOL = 'scope_isolation_probe';
const SCHEMA = 'scopeIsolationReply';

/** A scope holding the same tool, profile and schema names as every other, answering `tag`. */
function taggedScope(tag: string): KernelScope {
  const scope = createKernelScope();
  scope.tools.register({
    type: 'function',
    name: TOOL,
    description: `answers ${tag}`,
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ tag: z.string() }),
    handler: () => ({ tag }),
  });
  scope.schemas.register(SCHEMA, {
    jsonSchema: { type: 'object', properties: { [tag]: { type: 'string' } } },
  });
  scope.profiles.register(
    defineProfile({
      type: 'text',
      identity: { handle: tag, system: `system ${tag}` },
      id: PROFILE,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [TOOL] },
      inputs: { text: true },
      outputs: { structured: SCHEMA },
    }),
  );
  return scope;
}

async function* noEvents(): AsyncGenerator<TurnEvent> {}

/** A provider that records the request it was given and answers with nothing. */
function recordingProvider(into: ProviderCompleteRequest[]): ModelProvider {
  return {
    complete(req) {
      into.push(req);
      return noEvents();
    },
  };
}

Deno.test('scopes with the same names keep their own tools, profiles and schemas', async () => {
  const a = taggedScope('alpha');
  const b = taggedScope('beta');

  assertEquals(a.profiles.get(PROFILE) === b.profiles.get(PROFILE), false);
  assertEquals(a.tools.get(TOOL)?.description, 'answers alpha');
  assertEquals(b.tools.get(TOOL)?.description, 'answers beta');
  assertEquals(Object.keys(a.schemas.get(SCHEMA).jsonSchema.properties ?? {}), ['alpha']);
  assertEquals(Object.keys(b.schemas.get(SCHEMA).jsonSchema.properties ?? {}), ['beta']);

  for (const [scope, tag] of [
    [a, 'alpha'],
    [b, 'beta'],
  ] as const) {
    const events = await Array.fromAsync(
      scope.invokeTool({ profile: PROFILE, name: TOOL, input: {} }),
    );
    assertEquals(toolEventsOf(events, 'complete')[0]?.output, { tag });
  }
});

Deno.test('a scope runs turns on its own registry, never the default one', async () => {
  const a = taggedScope('alpha');
  const b = taggedScope('beta');
  const seenA: ProviderCompleteRequest[] = [];
  const seenB: ProviderCompleteRequest[] = [];

  await Array.fromAsync(
    a.runTurn({ profile: PROFILE, input: { text: 'hi' } }, recordingProvider(seenA)),
  );
  await Array.fromAsync(
    b.runTurn({ profile: PROFILE, input: { text: 'hi' } }, recordingProvider(seenB)),
  );

  assertEquals(seenA[0]?.system.includes('system alpha'), true);
  assertEquals(seenA[0]?.system.includes('system beta'), false);
  assertEquals(seenB[0]?.system.includes('system beta'), true);
  assertEquals(Object.keys(seenA[0]?.structured?.jsonSchema.properties ?? {}), ['alpha']);
  assertEquals(Object.keys(seenB[0]?.structured?.jsonSchema.properties ?? {}), ['beta']);

  assertEquals(hasProfile(PROFILE), false);
  assertEquals(hasTool(TOOL), false);
  await assertRejects(
    () =>
      Array.fromAsync(runTurn({ profile: PROFILE, input: { text: 'hi' } }, recordingProvider([]))),
    TheoremError,
  );
});
