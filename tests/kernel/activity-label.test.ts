import '../fixtures/test-host.ts';
import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import { toolCallsOf } from '../../src/interface/tool-calls.ts';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { fillActivityLabel } from '../../src/kernel/tools/activity-label.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { invokeRegisteredTool } from '../fixtures/test-tools.ts';

Deno.test('a label takes {{x}}, a fallback, a chosen side, a list length and its last item', () => {
  const output = { amount: 18.4, results: [{ name: 'Lyon' }, { name: 'Paris' }] };
  const values = { input: { amount: 20, ok: true }, output };
  assertEquals(fillActivityLabel('Found {{ results.0.name }}', values), 'Found Lyon');
  assertEquals(fillActivityLabel('{amount} became {output.amount}', values), '20 became 18.4');
  assertEquals(
    fillActivityLabel('{results.length}, last {results.-1.name}', values),
    '2, last Paris',
  );
  assertEquals(fillActivityLabel('Found {results.5.name|nothing}', values), 'Found nothing');
  assertEquals(fillActivityLabel('Saved {ok|}', values), 'Saved');
  assertEquals(fillActivityLabel('{output.amount|soon}', { input: {} }), 'soon');
});

Deno.test('a date reads as a date, at the time the tool wrote', () => {
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
  const dayTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const fill = (d: string) => fillActivityLabel('{d}', { input: { d } });
  assertEquals(fill('2026-09-30'), day.format(Date.UTC(2026, 8, 30)));
  assertEquals(fill('2026-09-30T14:05+02:00'), dayTime.format(Date.UTC(2026, 8, 30, 14, 5)));
  assertEquals(fill('2026-02-31'), '2026-02-31');
});

Deno.test('a tool whose label reads a field it does not have is refused at registration', () => {
  const tool = (activityPast: string) => ({
    type: 'function' as const,
    name: 'label_checked',
    description: 'Checks its labels',
    category: 'test',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    labels: { activity: 'Saving {title}', activityPast },
    input: z.object({ title: z.string() }),
    output: z.object({ position: z.number(), saved: z.boolean() }),
    handler: () => Promise.resolve({ position: 1, saved: true }),
  });
  registerTool(tool('Saved {title} as #{position}'));
  assertThrows(
    () => registerTool(tool('Saved {postion}')),
    TheoremError,
    "activityPast label: {postion} is not a field of this tool's input or output. Try {title} or {position}.",
  );
  assertThrows(() => registerTool(tool('Saved: {saved}')), TheoremError, 'is true or false');
});

Deno.test('an activity label fills from the input, then the output', () => {
  const values = {
    input: { value: 20, from: 'c', to: 'f' },
    output: { result: 68.0000001, from: 'ignored' },
  };
  assertEquals(fillActivityLabel('{value} {from} is {result} {to}', values), '20 c is 68 f');
  assertEquals(
    fillActivityLabel('Found {results.0.name}', {
      input: {},
      output: { results: [{ name: 'Paris' }] },
    }),
    'Found Paris',
  );
  assertEquals(fillActivityLabel('Checking the docs', { input: {} }), 'Checking the docs');
});

Deno.test('a filled value is one printable line, cut whole characters at a time', () => {
  const fill = (s: string) => fillActivityLabel('{s}', { input: { s } });
  assertEquals(fill('Paris\u202Eecnarf\u0007'), 'Paris ecnarf');
  assertEquals(fill('Paris\n\n  France'), 'Paris France');
  assertEquals(fill(`${'a'.repeat(38)}😀😀😀`), `${'a'.repeat(38)}😀…`);
  assertEquals(fillActivityLabel('{n}', { input: { n: Number.NaN } }), undefined);
});

Deno.test('an activity label with a value it cannot show is not filled', () => {
  const label = 'Saving {title} to your collection';
  assertEquals(fillActivityLabel(label, { input: {} }), undefined);
  assertEquals(fillActivityLabel(label, { input: { title: '  ' } }), undefined);
  assertEquals(fillActivityLabel(label, { input: { title: ['Monty'] } }), undefined);
  assertEquals(fillActivityLabel(label, { input: { title: { name: 'Monty' } } }), undefined);
  assertEquals(fillActivityLabel('Found {results.3.name}', { input: { results: [] } }), undefined);
  assertEquals(fillActivityLabel(undefined, { input: {} }), undefined);
  assertEquals(fillActivityLabel('  ', { input: {} }), undefined);
});

Deno.test('a long value is cut, and whitespace in it collapses', () => {
  assertEquals(
    fillActivityLabel('Reading {title}', { input: { title: `${'x'.repeat(60)}` } }),
    `Reading ${'x'.repeat(39)}…`,
  );
  assertEquals(
    fillActivityLabel('Reading {title}', { input: { title: 'Paris\n  France' } }),
    'Reading Paris France',
  );
});

Deno.test('a call carries its filled activity labels to the transcript', async () => {
  registerTool({
    type: 'function',
    name: 'save_to_collection',
    description: 'Save an item to the collection',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    labels: {
      activity: 'Saving {title} to your collection',
      activityPast: 'Saved {title} as #{position}',
    },
    input: z.object({ title: z.string() }),
    output: z.object({ position: z.number() }),
    handler: () => Promise.resolve({ position: 12 }),
  });
  registerProfile(
    defineProfile({
      type: 'host',
      id: 'activity_label_host',
      tools: { allow: ['save_to_collection'] },
      observability: { writeTo: false },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'activity_label_host',
    name: 'save_to_collection',
    input: { title: 'Monty' },
  });
  assertEquals(toolEventsOf(events, 'running')[0]?.activity, 'Saving Monty to your collection');
  assertEquals(toolEventsOf(events, 'complete')[0]?.activityPast, 'Saved Monty as #12');
  const [call] = toolCallsOf(events);
  assertEquals(call?.activity, 'Saving Monty to your collection');
  assertEquals(call?.activityPast, 'Saved Monty as #12');
});
