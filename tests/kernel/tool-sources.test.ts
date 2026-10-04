import '../fixtures/test-host.ts';
import { z } from 'zod';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { type Source, sourceSchema } from '../../src/kernel/turn-events.ts';
import { eventsOf, lastTool, toolEventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';
import { invokeRegisteredTool } from '../fixtures/test-tools.ts';

const PORTO: Source = { title: 'Porto', uri: 'https://example.com/porto', type: 'web' };

/** Sources as a host without types (or a stale cast) hands them over: unchecked. */
function unchecked(json: string): Source[] {
  return JSON.parse(json);
}

/** Register `name` returning Porto's link, with `sources`, and a profile allowing it. */
function registerCitingTool(
  name: string,
  sources: (output: { links: Source[] }) => Source[],
): void {
  registerTool({
    type: 'function',
    name,
    description: 'Returns links it cites',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ links: z.array(sourceSchema) }),
    handler: () => ({ links: [PORTO] }),
    sources,
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: `${name}_bot`,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [name] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
}

async function invoke(name: string) {
  return await invokeRegisteredTool({ profile: `${name}_bot`, name, input: {} });
}

Deno.test('a tool that declares sources cites them with its call id, before it completes', async () => {
  registerCitingTool('cites_porto', (output) => output.links);
  const events = await invoke('cites_porto');
  const [citation] = eventsOf(events, 'citation');
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(citation?.sources, [PORTO]);
  assertEquals(citation?.callId, complete?.callId);
  assertEquals(typeof complete?.callId, 'string');
  const citedAt = events.findIndex((e) => e.type === 'citation');
  const completedAt = events.findIndex((e) => e.type === 'tool' && e.tool.phase === 'complete');
  assertEquals(citedAt < completedAt, true);
  assertEquals(toolEventsOf(events, 'warning'), []);
});

Deno.test('a malformed source is a sources_invalid warning and is not cited; the rest are', async () => {
  registerCitingTool('cites_some_bad', (output) => [
    ...output.links,
    ...unchecked('[{ "title": "No link", "type": "web" }]'),
  ]);
  const events = await invoke('cites_some_bad');
  assertEquals(
    eventsOf(events, 'citation').map((e) => e.sources),
    [[PORTO]],
  );
  const warnings = toolEventsOf(events, 'warning').map((e) => e.warning);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]?.code, 'sources_invalid');
  assertEquals(warnings[0]?.message.includes('[1] uri'), true);
  assertEquals(lastTool(events, 'cites_some_bad')?.phase, 'complete');
});

Deno.test('sources that all fail, or throw, cite nothing and the call still completes', async () => {
  registerCitingTool('cites_only_bad', () => unchecked('[{ "uri": "https://example.com" }]'));
  registerCitingTool('sources_throw', () => {
    throw new Error('no links here');
  });
  for (const name of ['cites_only_bad', 'sources_throw']) {
    const events = await invoke(name);
    assertEquals(eventsOf(events, 'citation'), []);
    assertEquals(
      toolEventsOf(events, 'warning').map((e) => e.warning.code),
      ['sources_invalid'],
    );
    assertEquals(lastTool(events, name)?.phase, 'complete');
  }
});

Deno.test('a call that fails never runs its tool sources', async () => {
  let ran = false;
  registerTool({
    type: 'function',
    name: 'fails_before_citing',
    description: 'Fails',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ links: z.array(z.string()) }),
    handler: () => {
      throw new Error('upstream down');
    },
    sources: () => {
      ran = true;
      return [PORTO];
    },
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'fails_before_citing_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['fails_before_citing'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invoke('fails_before_citing');
  assertEquals(lastTool(events, 'fails_before_citing')?.phase, 'error');
  assertEquals(eventsOf(events, 'citation'), []);
  assertEquals(ran, false);
});
