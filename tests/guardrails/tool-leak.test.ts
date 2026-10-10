import { assert, assertEquals } from '@std/assert';
import { z } from 'zod';
import { detectAt, scopeOf } from '../../src/guardrails/detect-at.ts';
import { createDetectStream } from '../../src/guardrails/detect-stream.ts';
import { type DetectSpec, detectProblem, resolveDetect } from '../../src/guardrails/detectors.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import type { OwnTools } from '../../src/guardrails/tool-leak.ts';
import { ownToolsOf } from '../../src/kernel/tools/project.ts';
import { createToolRegistry } from '../../src/kernel/tools/registry.ts';

const OWN: OwnTools = { names: ['get_weather', 'search'], params: ['city', 'units'] };

function read(text: string, spec: DetectSpec = { tool_leak: 'redact' }, own: OwnTools = OWN) {
  const policy = resolveGuardrailPolicy({ detect: spec });
  return detectAt(text, 'reply', policy.detect, scopeOf(policy, { ownTools: own }));
}

/** `text` streamed a character at a time, released as far as the stream lets it. */
function streamed(text: string, spec: DetectSpec, own: OwnTools = OWN) {
  const policy = resolveGuardrailPolicy({ detect: spec });
  const scope = scopeOf(policy, { ownTools: own });
  const stream = createDetectStream('reply', policy.detect, scope);
  assert(stream);
  let out = '';
  let from = 0;
  const actions: string[] = [];
  const take = (to: number, ended = false) => {
    if (to <= from && !ended) return;
    const release = stream.take(from, to, ended);
    actions.push(release.action);
    out += release.text ?? '';
    from += release.taken;
  };
  for (const char of text) {
    stream.push(char);
    take(stream.holdFrom());
  }
  take(text.length, true);
  return { out, actions };
}

Deno.test('tool_leak flags by default, and names a tool only as a word of its own', () => {
  const flagged = read('I called get_weather for you.', {});
  assertEquals(flagged.action, 'flag');
  assertEquals(
    flagged.hits.map(({ rule }) => rule),
    ['detect.tool_leak'],
  );
  assertEquals(read('I called get_weather.').text, 'I called [omitted - tool].');
  assertEquals(read('See get_weather_v2 and research.').action, 'allow');
  assertEquals(read('Get_Weather is not it.').action, 'allow');
});

Deno.test('a parameter is found in double quotes, as tool-call JSON writes it', () => {
  assertEquals(read('Which city do you mean?').action, 'allow');
  assertEquals(read('{"city": "Oslo"}').text, '{[omitted - tool]: "Oslo"}');
  assertEquals(read('{\\"units\\": 1}').text, '{[omitted - tool]: 1}');
});

Deno.test('allow.names lets an innocent name through, and without tools nothing is found', () => {
  const spec: DetectSpec = { tool_leak: { action: 'block', allow: { names: ['search'] } } };
  assertEquals(read('Try a search.', spec).action, 'allow');
  assertEquals(read('Try get_weather.', spec).action, 'block');
  const policy = resolveGuardrailPolicy({ detect: { tool_leak: 'block' } });
  assertEquals(
    detectAt('get_weather', 'reply', policy.detect, scopeOf(policy, {})).action,
    'allow',
  );
});

Deno.test('allow on tool_leak takes names only', () => {
  assertEquals(detectProblem('Detect', { tool_leak: { allow: { names: ['search'] } } }), undefined);
  assert(detectProblem('Detect', { tool_leak: { allow: { hosts: ['a.com'] } } } as DetectSpec));
  assert(detectProblem('Detect', { tool_leak: { allow: { names: [''] } } }));
  assert(detectProblem('Detect', { ids: { allow: { names: ['x'] } } } as DetectSpec));
  assertEquals(resolveDetect({ tool_leak: { allow: { names: ['search'] } } }).innocent, ['search']);
});

Deno.test('a streamed reply holds a name until it is one, and reads as the whole reply does', () => {
  const redact: DetectSpec = { tool_leak: 'redact' };
  for (const text of [
    'I called get_weather for you, then search.',
    'Not get_weather_v2, and not research. {"city": 1}',
    'It ends on get_weather',
    'nothing here at all',
  ]) {
    assertEquals(streamed(text, redact).out, read(text).text, text);
  }
  const blocked = streamed('I called get_weather for you.', { tool_leak: 'block' });
  assertEquals(blocked.actions.at(-1), 'block');
  assert(!blocked.out.includes('get_weather'), blocked.out);
});

Deno.test("a profile's own tools are its tools' names and their parameters at any depth", () => {
  const tools = createToolRegistry();
  tools.register({
    type: 'function',
    name: 'get_weather',
    description: 'Weather.',
    access: 'read',
    input: z.object({
      city: z.string(),
      when: z.object({ day: z.string() }),
      stops: z.array(z.object({ at: z.string() })),
    }),
    output: z.object({}),
    handler: () => Promise.resolve({}),
  } as never);
  const own = ownToolsOf(tools, {
    type: 'host',
    id: 'h',
    tools: { allow: ['get_weather'] },
  } as never);
  assertEquals(own, { names: ['get_weather'], params: ['city', 'when', 'day', 'stops', 'at'] });
});
