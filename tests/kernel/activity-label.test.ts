import '../fixtures/test-host.ts';
import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import { toolCallsOf } from '../../src/interface/tool-calls.ts';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { activityLabelProblem, fillActivityLabel } from '../../src/kernel/tools/activity-label.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { invokeRegisteredTool } from '../fixtures/test-tools.ts';

Deno.test('a label takes {{x}}, a fallback, a chosen side, a list length, and its last item', () => {
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

Deno.test('a filled value is one printable line', () => {
  const fill = (s: string) => fillActivityLabel('{s}', { input: { s } });
  assertEquals(fill('Paris\u202Eecnarf\u0007'), 'Paris ecnarf');
  assertEquals(fill('Paris\n\n  France'), 'Paris France');
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

Deno.test('a long value is shown whole, and whitespace in it collapses', () => {
  assertEquals(
    fillActivityLabel('Reading {title}', { input: { title: `${'x'.repeat(60)}😀` } }),
    `Reading ${'x'.repeat(60)}😀`,
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

Deno.test('post_tool receives the filled past label, and none when the call failed', async () => {
  const base = {
    type: 'function' as const,
    description: 'Save an item to the shelf',
    category: 'test',
    access: 'read-write' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    labels: { activityPast: 'Shelved {title} as #{position}' },
    input: z.object({ title: z.string() }),
    output: z.object({ position: z.number() }),
  };
  registerTool({ ...base, name: 'shelve_item', handler: () => Promise.resolve({ position: 3 }) });
  registerTool({
    ...base,
    name: 'shelve_item_broken',
    handler: () => Promise.reject(new Error('shelf fell')),
  });
  registerProfile(
    defineProfile({
      type: 'host',
      id: 'stage_label_host',
      tools: { allow: ['shelve_item', 'shelve_item_broken'] },
      observability: { writeTo: false },
    }),
  );
  const seen: (string | undefined)[] = [];
  const labelAfter = async (name: string) => {
    await invokeRegisteredTool({
      profile: 'stage_label_host',
      name,
      input: { title: 'Fern' },
      onStage: (ctx) => {
        if (ctx.stage === 'post_tool') seen.push(ctx.activityPast);
        return undefined;
      },
    });
  };
  await labelAfter('shelve_item');
  await labelAfter('shelve_item_broken');
  assertEquals(seen, ['Shelved Fern as #3', undefined]);
});

Deno.test('a failed call shows its failed label, and a hook can ask for it on a call that ran', async () => {
  const base = {
    type: 'function' as const,
    description: 'Files a note in the drawer',
    category: 'test',
    access: 'read-write' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    input: z.object({ title: z.string() }),
    output: z.object({ filed: z.boolean() }),
  };
  const labels = { activityPast: 'Filed {title}', activityFailed: "Couldn't file {title}" };
  const refuse = () => Promise.resolve({ filed: false });
  registerTool({ ...base, name: 'file_note', labels, handler: refuse });
  registerTool({ ...base, name: 'file_note_plain', handler: refuse });
  registerTool({
    ...base,
    name: 'file_note_broken',
    labels,
    handler: () => Promise.reject(new Error('drawer stuck')),
  });
  registerProfile(
    defineProfile({
      type: 'host',
      id: 'failed_label_host',
      tools: { allow: ['file_note', 'file_note_plain', 'file_note_broken'] },
      observability: { writeTo: false },
    }),
  );
  const given: (string | undefined)[] = [];
  const settle = async (name: string, labelFailed: boolean) => {
    const events = await invokeRegisteredTool({
      profile: 'failed_label_host',
      name,
      input: { title: 'Fern' },
      onStage: (ctx) => {
        if (ctx.stage !== 'post_tool') return undefined;
        given.push(ctx.activityFailed);
        return labelFailed ? { labelFailed: true } : undefined;
      },
    });
    const [call] = toolCallsOf(events);
    return { phase: call?.state?.phase, label: call?.activityPast };
  };
  assertEquals(await settle('file_note', false), { phase: 'complete', label: 'Filed Fern' });
  assertEquals(await settle('file_note', true), {
    phase: 'complete',
    label: "Couldn't file Fern",
  });
  assertEquals(await settle('file_note_plain', true), {
    phase: 'complete',
    label: "Couldn't complete file note plain",
  });
  assertEquals(await settle('file_note_broken', false), {
    phase: 'error',
    label: "Couldn't file Fern",
  });
  assertEquals(given, [
    "Couldn't file Fern",
    "Couldn't file Fern",
    "Couldn't complete file note plain",
    "Couldn't file Fern",
  ]);
});

Deno.test('a failed label reads the input only, and a call to no tool names it in words', async () => {
  assertThrows(
    () =>
      registerTool({
        type: 'function',
        name: 'file_note_output',
        description: 'Files a note',
        category: 'test',
        access: 'read-write',
        paths: ['*'],
        loadTier: 'T0',
        permission: 'auto',
        labels: { activityFailed: "Couldn't file {output.filed}" },
        input: z.object({ title: z.string() }),
        output: z.object({ filed: z.string() }),
        handler: () => Promise.resolve({ filed: 'no' }),
      }),
    TheoremError,
    'activityFailed label: {output.filed} is only there once the call is done',
  );
  registerProfile(
    defineProfile({
      type: 'host',
      id: 'no_tool_label_host',
      tools: { allow: [] },
      observability: { writeTo: false },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'no_tool_label_host',
    name: 'no_such_tool',
    input: {},
  });
  assertEquals(toolEventsOf(events, 'error')[0]?.activityPast, "Couldn't complete no such tool");
});

Deno.test('a gate carries the tool access and its request filled from the call input', async () => {
  const base = {
    description: 'Books a table',
    category: 'test',
    access: 'read-write' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    labels: { request: 'book a table at {venue}' },
    input: z.object({ venue: z.string() }),
    output: z.object({ ok: z.boolean() }),
  };
  registerTool({
    ...base,
    type: 'function',
    name: 'request_every_call',
    permission: 'always_confirm',
    handler: () => Promise.resolve({ ok: true }),
  });
  registerTool({
    ...base,
    type: 'function',
    name: 'request_once',
    permission: 'session_consent',
    handler: () => Promise.resolve({ ok: true }),
  });
  registerTool({
    ...base,
    type: 'function',
    name: 'request_confirm',
    permission: 'auto',
    preTool: () => ({ confirm: { summary: 'Book it?' } }),
    handler: () => Promise.resolve({ ok: true }),
  });
  registerTool({
    ...base,
    type: 'http',
    name: 'request_http',
    permission: 'always_confirm',
    endpoint: 'https://api.example.com/book',
    method: 'POST',
  });
  registerTool({
    ...base,
    labels: { request: 'book a table at {venue|somewhere}' },
    type: 'function',
    name: 'request_fallback',
    permission: 'always_confirm',
    handler: () => Promise.resolve({ ok: true }),
  });
  registerTool({
    ...base,
    labels: {},
    type: 'function',
    name: 'request_unset',
    permission: 'always_confirm',
    handler: () => Promise.resolve({ ok: true }),
  });
  const names = [
    'request_every_call',
    'request_once',
    'request_confirm',
    'request_http',
    'request_fallback',
    'request_unset',
  ];
  registerProfile(
    defineProfile({
      type: 'host',
      id: 'request_label_host',
      tools: { allow: names },
      observability: { writeTo: false },
    }),
  );
  const gateOf = async (name: string, input: unknown) =>
    toolEventsOf(
      await invokeRegisteredTool({ profile: 'request_label_host', name, input }),
      'gate',
    )[0]?.gate;

  for (const name of ['request_every_call', 'request_once', 'request_confirm', 'request_http']) {
    const gate = await gateOf(name, { venue: 'Noma' });
    assertEquals([name, gate?.request, gate?.access], [name, 'book a table at Noma', 'read-write']);
  }
  assertEquals((await gateOf('request_confirm', { venue: 'Noma' }))?.summary, 'Book it?');
  assertEquals(
    (await gateOf('request_fallback', { venue: ' ' }))?.request,
    'book a table at somewhere',
  );
  const unset = await gateOf('request_unset', { venue: 'Noma' });
  assertEquals(unset?.kind, 'permission');
  assertEquals(unset !== undefined && 'request' in unset, false);
});

Deno.test('a tool whose request label reads its output is refused at registration', () => {
  assertThrows(
    () =>
      registerTool({
        type: 'function',
        name: 'request_reads_output',
        description: 'Reads its output too early',
        category: 'test',
        access: 'read-only',
        paths: ['*'],
        loadTier: 'T0',
        permission: 'always_confirm',
        labels: { request: 'save {position}' },
        input: z.object({ title: z.string() }),
        output: z.object({ position: z.number() }),
        handler: () => Promise.resolve({ position: 1 }),
      }),
    TheoremError,
    "request label: {position} is not a field of this tool's input. Try {title}.",
  );
});

Deno.test('operation identity keeps distinct actions when a provider reuses its call ID', () => {
  const calls = toolCallsOf(
    ['first', 'second'].flatMap((operationId) => [
      {
        type: 'tool' as const,
        tool: { name: 'lookup', callId: 'reused', operationId, arguments: { operationId } },
      },
      {
        type: 'tool' as const,
        tool: {
          name: 'lookup',
          callId: 'reused',
          operationId,
          at: 0,
          phase: 'complete' as const,
          output: {},
        },
      },
    ]),
  );
  assertEquals(
    calls.map((call) => [call.operationId, call.arguments, call.state?.phase]),
    [
      ['first', { operationId: 'first' }, 'complete'],
      ['second', { operationId: 'second' }, 'complete'],
    ],
  );
});

Deno.test('operation identity refuses a phase with different call correlation', () => {
  assertThrows(
    () =>
      toolCallsOf([
        {
          type: 'tool',
          tool: { name: 'lookup', callId: 'first', operationId: 'operation', arguments: {} },
        },
        {
          type: 'tool',
          tool: {
            name: 'lookup',
            callId: 'second',
            operationId: 'operation',
            at: 0,
            phase: 'complete',
            output: {},
          },
        },
      ]),
    TheoremError,
  );
});

const PLANT_LABEL = [
  'when status is inactive: archiving {plant_identifier}',
  'adding {nickname}',
  '+ renaming {plant_identifier} to {nickname}',
  '+ moving {plant_identifier} to {location}',
  '+ when in_bloom is true: marking {plant_identifier} in bloom',
  'saving a plant',
];

const PLANT_INPUT = {
  type: 'object',
  properties: {
    plant_identifier: { type: 'string' },
    nickname: { type: 'string' },
    location: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    status: { type: 'string', enum: ['active', 'inactive'] },
    in_bloom: { type: 'boolean' },
    count: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

Deno.test('a list label shows its first line that fits', () => {
  const fill = (input: unknown) => fillActivityLabel(PLANT_LABEL, { input });
  assertEquals(
    fill({ plant_identifier: 'Fern', status: 'inactive', nickname: 'Fernanda' }),
    'archiving Fern',
  );
  assertEquals(fill({ nickname: 'Fernanda' }), 'adding Fernanda');
  assertEquals(fill({ plant_identifier: 'Fern', status: 'active' }), 'saving a plant');
  assertEquals(fill({}), 'saving a plant');
});

Deno.test('neighbouring + lines that fit are joined in words', () => {
  const lines = PLANT_LABEL.slice(2);
  const fill = (input: unknown) => fillActivityLabel(lines, { input });
  assertEquals(fill({ plant_identifier: 'Fern', location: 'the hall' }), 'moving Fern to the hall');
  assertEquals(
    fill({ plant_identifier: 'Fern', nickname: 'Fernanda', location: 'the hall' }),
    'renaming Fern to Fernanda and moving Fern to the hall',
  );
  assertEquals(
    fill({ plant_identifier: 'Fern', nickname: 'Fernanda', location: 'the hall', in_bloom: true }),
    'renaming Fern to Fernanda, moving Fern to the hall, and marking Fern in bloom',
  );
  assertEquals(fill({ plant_identifier: 'Fern', in_bloom: false }), 'saving a plant');
});

Deno.test('a + run split by a plain line is two runs', () => {
  const lines = ['+ naming it {a}', 'moving it to {b}', '+ lighting it {c}', 'saving'];
  assertEquals(fillActivityLabel(lines, { input: { a: 'x', c: 'z' } }), 'naming it x');
  assertEquals(fillActivityLabel(lines, { input: { b: 'y', c: 'z' } }), 'moving it to y');
  assertEquals(fillActivityLabel(lines, { input: { c: 'z' } }), 'lighting it z');
});

Deno.test('a when compares what the model sent: `is`, `is not`, `is null`, and `and`', () => {
  const fits = (when: string, input: unknown) =>
    fillActivityLabel([`when ${when}: yes`, 'no'], { input });
  assertEquals(fits('status is inactive', { status: 'inactive' }), 'yes');
  assertEquals(fits('status is inactive', { status: 'active' }), 'no');
  assertEquals(fits('status is inactive', {}), 'no');
  assertEquals(fits('status is not inactive', { status: 'active' }), 'yes');
  assertEquals(fits('status is not inactive', {}), 'yes');
  assertEquals(fits('status is not inactive', { status: 'inactive' }), 'no');
  assertEquals(fits('location is null', { location: null }), 'yes');
  assertEquals(fits('location is null', {}), 'no');
  assertEquals(fits('location is null', { location: 'hall' }), 'no');
  assertEquals(fits('location is not null', { location: 'hall' }), 'yes');
  assertEquals(fits('location is not null', { location: null }), 'no');
  assertEquals(fits('in_bloom is true', { in_bloom: true }), 'yes');
  assertEquals(fits('count is 1200', { count: 1200 }), 'yes');
  assertEquals(fits('place.room is the hall', { place: { room: 'the hall' } }), 'yes');
  assertEquals(fits('status is inactive and in_bloom is false', { status: 'inactive' }), 'no');
  assertEquals(
    fits('status is inactive and in_bloom is false', { status: 'inactive', in_bloom: false }),
    'yes',
  );
});

Deno.test('a one-line label takes a when, and names the tool when it does not hold', () => {
  const label = 'when status is inactive: archiving {plant_identifier}';
  assertEquals(
    fillActivityLabel(label, { input: { status: 'inactive', plant_identifier: 'Fern' } }),
    'archiving Fern',
  );
  assertEquals(fillActivityLabel(label, { input: { plant_identifier: 'Fern' } }), undefined);
  assertEquals(activityLabelProblem(label, { input: PLANT_INPUT }), undefined);
  assertEquals(activityLabelProblem('Saving {nickname}', { input: PLANT_INPUT }), undefined);
});

Deno.test('a list label that cannot work is refused, with its line', () => {
  const problem = (lines: string[]) => activityLabelProblem(lines, { input: PLANT_INPUT });
  assertEquals(problem(PLANT_LABEL), undefined);
  assertEquals(problem(['when location is null: clearing its place', 'saving']), undefined);
  assertEquals(problem(['when count is 3: saving three', 'saving {nickname|a plant}']), undefined);
  assertEquals(
    problem(['adding {nickname}']),
    'The last line must always fit, so every call gets a label: no "when", and a fallback on every {value}, like "saving the item".',
  );
  assertEquals(problem([]), problem(['adding {nickname}']));
  assertEquals(problem(['+ adding {nickname}', '+ moving to {location}']), problem([]));
  assertEquals(
    problem(['adding {nickname}', 'saving a plant', 'moving to {location}', 'saving']),
    'Line 2 always fits, so the lines below it are never read. Move it to the end.',
  );
  assertEquals(
    problem(['when staus is inactive: archiving', 'saving']),
    'Line 1: "staus" in the "when" is not a field of this tool\'s input. Try "plant_identifier", "nickname", "location", or "status".',
  );
  assertEquals(
    problem(['adding {nickname}', 'when status is inactiv: archiving', 'saving']),
    'Line 2: "status" is never "inactiv". It is "active" or "inactive".',
  );
  assertEquals(
    problem(['when in_bloom is yes: blooming', 'saving']),
    'Line 1: "in_bloom" is never "yes". It is "true" or "false".',
  );
  assertEquals(
    problem(['when nickname is null: clearing', 'saving']),
    'Line 1: "nickname" is never null.',
  );
  assertEquals(
    problem(['when tags is red: tagging', 'saving']),
    'Line 1: "tags" in the "when" is a list or group; a "when" compares text, a number, or true or false.',
  );
  assertEquals(
    problem(['when output.saved is true: saved', 'saving']),
    'Line 1: A "when" reads what the model sent; "output.saved" is only there once the call is done.',
  );
  const unreadable =
    'Line 1: A line that opens with "when" needs a condition and a colon, like "when status is archived: archiving {name}". A condition uses "is", "is not", "is null", and "and".';
  assertEquals(problem(['when it rains', 'saving']), unreadable);
  assertEquals(problem(['when status equals inactive: archiving', 'saving']), unreadable);
  assertEquals(
    problem(['when status is inactive:', 'saving']),
    'Line 1: It has no wording to show.',
  );
  assertEquals(problem(['', 'saving']), 'Line 1: It has no wording to show.');
  assertEquals(
    problem(['adding {nicknam}', 'saving']),
    "Line 1: {nicknam} is not a field of this tool's input. Try {plant_identifier}, {nickname}, {location}, or {status}.",
  );
});

Deno.test('a tool whose list label cannot work is refused at registration', () => {
  const tool = (activity: string[]) => ({
    type: 'function' as const,
    name: 'list_label_checked',
    description: 'Checks its list labels',
    category: 'test',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    labels: { activity },
    input: z.object({ title: z.string().optional(), status: z.enum(['kept', 'archived']) }),
    output: z.object({ saved: z.boolean() }),
    handler: () => Promise.resolve({ saved: true }),
  });
  registerTool(tool(['when status is archived: archiving {title}', 'saving {title|an item}']));
  assertThrows(
    () => registerTool(tool(['when status is gone: archiving {title}', 'saving'])),
    TheoremError,
    'Tool "list_label_checked" activity label: Line 1: "status" is never "gone". It is "kept" or "archived".',
  );
  assertThrows(
    () => registerTool(tool(['saving {title}'])),
    TheoremError,
    'The last line must always fit',
  );
});

Deno.test('a mistyped list offers the list that is there, its length first when the label ended in one', () => {
  const output = {
    type: 'object',
    properties: {
      result: {
        type: 'array',
        items: { type: 'object', properties: { region_id: { type: 'string' } } },
      },
    },
  };
  assertEquals(
    activityLabelProblem('Listed {regions.length} regions', {
      input: { type: 'object', properties: {} },
      output,
    }),
    "{regions.length} is not a field of this tool's input or output. Try {result.length} or {result.0.region_id}.",
  );
});
