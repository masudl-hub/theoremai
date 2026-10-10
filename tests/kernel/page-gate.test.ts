import { createTestKernelScope as createKernelScope } from '../fixtures/provider-scope.ts';
import '../fixtures/test-host.ts';
import { z } from 'zod';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import { answerGatedCall } from '../../src/kernel/tools/gate-answer.ts';
import type { PageAnswer } from '../../src/kernel/tools/types.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const PROFILE = 'page_gate_agent';

function scopeWithPageTool(permission: 'auto' | 'always_confirm' = 'auto'): KernelScope {
  const scope = createKernelScope();
  scope.tools.register({
    type: 'function',
    name: 'highlight',
    description: 'Highlights something on the page.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission,
    input: z.object({ id: z.string() }),
    output: z.object({ shown: z.boolean() }),
    answeredBy: 'page',
  });
  scope.profiles.register(
    defineProfile({
      id: PROFILE,
      type: 'text',
      identity: { handle: PROFILE, system: 'You help.' },
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: ['highlight'] },
      inputs: { text: true },
    }),
  );
  return scope;
}

async function invoke(
  scope: KernelScope,
  over: { page?: PageAnswer; granted?: boolean } = {},
): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of scope.invokeTool({
    profile: PROFILE,
    name: 'highlight',
    input: { id: 'pricing' },
    ...(over.page ? { page: over.page } : {}),
    ...(over.granted ? { resume: { granted: true } } : {}),
  })) {
    events.push(event);
  }
  return events;
}

function phases(events: TurnEvent[]): (string | undefined)[] {
  return events.flatMap((e) => (e.type === 'tool' && 'phase' in e.tool ? [e.tool.phase] : []));
}

function gateKinds(events: TurnEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === 'tool' && 'phase' in e.tool && e.tool.phase === 'gate' ? [e.tool.gate.kind] : [],
  );
}

Deno.test('a page tool run with no answer is held at a page gate, and runs once the page answers', async () => {
  const scope = scopeWithPageTool();
  const held = await invoke(scope);
  assertEquals(gateKinds(held), ['page']);
  assertEquals(phases(held).includes('complete'), false);

  const answered = await invoke(scope, { page: { output: { shown: true } }, granted: true });
  assertEquals(gateKinds(answered), []);
  assertEquals(phases(answered).at(-1), 'complete');
});

Deno.test('a page that has nothing for the tool, or answers off-schema, fails the call', async () => {
  const scope = scopeWithPageTool();
  for (const page of [{ unanswered: true } as const, { output: { shown: 'yes' } }]) {
    const events = await invoke(scope, { page, granted: true });
    assertEquals(gateKinds(events), []);
    assertEquals(phases(events).at(-1), 'error');
  }
});

Deno.test('a page tool that needs permission is allowed first, then held for the page', async () => {
  const scope = scopeWithPageTool('always_confirm');
  assertEquals(gateKinds(await invoke(scope)), ['permission']);
  assertEquals(gateKinds(await invoke(scope, { granted: true })), ['page']);
});

Deno.test('a gate answer carries the page answer only with an approval', () => {
  const call = { name: 'highlight', arguments: { id: 'pricing' } };
  const page = { output: { shown: true } };
  assertEquals(answerGatedCall({ callId: 'c1', decision: 'approve', page }, call, []).page, page);
  let refused = false;
  try {
    answerGatedCall({ callId: 'c1', decision: 'deny', page }, call, []);
  } catch {
    refused = true;
  }
  assertEquals(refused, true);
});
