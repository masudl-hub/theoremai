import { assert, assertEquals, assertThrows } from '@std/assert';
import {
  assertToolSettings,
  createToolRegistry,
  defineProfile,
  TheoremError,
  z,
} from '../../mod.ts';
import { createBlankDraft } from '../../studio/draft.ts';
import { readStudioSource } from '../../studio/read-source.ts';

const MODEL = { provider: 'anthropic', protocol: 'anthropic-messages', apiId: 'claude-haiku-5-5' };
const PROFILE = {
  type: 'text',
  id: 'p',
  identity: { handle: 'p' },
  inputs: { text: true },
  models: { m: MODEL },
  tools: { allow: [] },
};

const literal = (value: unknown) => JSON.stringify(value);

function profileFile(profile: unknown): string {
  return `import { defineProfile } from '@theoremjs/agents';\nexport const profile = defineProfile(${literal(profile)});\n`;
}

function toolFile(tool: Record<string, unknown>): string {
  return `import { registerTool, defineProfile, z } from '@theoremjs/agents';\nregisterTool(${literal(
    tool,
  )});\nexport const profile = defineProfile(${literal(PROFILE)});\n`;
}

const withModel = (over: object) => ({ ...PROFILE, models: { m: { ...MODEL, ...over } } });

const BAD_PROFILES: [string, unknown, string][] = [
  ['temperature as text', withModel({ temperature: '0.5' }), 'temperature'],
  ['maxOutputTokens as text', withModel({ maxOutputTokens: '9' }), 'maxOutputTokens'],
  ['a model setting nobody takes', withModel({ tempratur: 1 }), 'tempratur'],
  ['builtInTools of numbers', withModel({ builtInTools: [1] }), 'builtInTools'],
  ['maxSteps as text', { ...PROFILE, maxSteps: '8' }, 'maxSteps'],
  ['sampleRate as text', { ...PROFILE, observability: { sampleRate: '1' } }, 'sampleRate'],
  ['atStepLimit off the list', { ...PROFILE, turnBehaviour: { atStepLimit: 'x' } }, 'atStepLimit'],
  [
    'allowSteering as text',
    { ...PROFILE, turnBehaviour: { allowSteering: 'no' } },
    'allowSteering',
  ],
  ['tools.parallel as text', { ...PROFILE, tools: { allow: [], parallel: 'yes' } }, 'parallel'],
  ['compaction as text', withModel({ compaction: 'x' }), 'compaction'],
  ['identity as text', { ...PROFILE, identity: 5 }, 'identity'],
  ['a guardrail nobody takes', { ...PROFILE, guardrails: { banana: 1 } }, 'banana'],
  ['a root setting nobody takes', { ...PROFILE, tempratur: 1 }, 'tempratur'],
];

const TOOL = { name: 't', description: 'd', handler: { ok: true } };

const BAD_TOOLS: [string, Record<string, unknown>][] = [
  ['background off the list', { ...TOOL, background: 'sometimes' }],
  ['afterMs as text', { ...TOOL, background: { afterMs: '5' } }],
  ['afterMs below zero', { ...TOOL, background: { afterMs: -1 } }],
  ['background on a page tool', { ...TOOL, answeredBy: 'page', background: 'always' }],
  ['a tool setting nobody takes', { ...TOOL, backgroound: 'ask' }],
  ['maxCallsPerTurn as text', { ...TOOL, maxCallsPerTurn: '2' }],
];

Deno.test('a valid profile and tool pass both the kernel and the studio', () => {
  defineProfile(PROFILE as never);
  assert(readStudioSource(profileFile(PROFILE), createBlankDraft()).ok);
  const read = readStudioSource(toolFile({ ...TOOL, background: 'never' }), createBlankDraft());
  assert(read.ok);
  assertEquals(read.registered[0]?.background, 'never');
});

for (const [name, profile, field] of BAD_PROFILES) {
  Deno.test(`the kernel and the studio both refuse a profile with ${name}`, () => {
    const thrown = assertThrows(() => defineProfile(profile as never), TheoremError);
    assert(thrown.message.includes(field), thrown.message);
    const read = readStudioSource(profileFile(profile), createBlankDraft());
    assert(!read.ok, `the studio opened ${name}`);
    assert(read.errors[0]?.message.includes(field), read.errors[0]?.message);
  });
}

for (const [name, tool] of BAD_TOOLS) {
  Deno.test(`the kernel and the studio both refuse a tool with ${name}`, () => {
    assertThrows(() => assertToolSettings(tool as never), TheoremError);
    const read = readStudioSource(toolFile(tool), createBlankDraft());
    assert(!read.ok, `the studio opened ${name}`);
  });
}

Deno.test('registering a tool runs the same check', () => {
  const tools = createToolRegistry();
  assertThrows(
    () =>
      tools.register({
        type: 'function',
        name: 't',
        description: 'd',
        category: 'c',
        access: 'read-only',
        paths: [],
        loadTier: 'always',
        permission: 'none',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
        background: 'sometimes' as never,
      } as never),
    TheoremError,
    'sometimes',
  );
});

Deno.test('the studio refuses a bad value on the line it is written', () => {
  const source = `import { defineProfile } from '@theoremjs/agents';\nexport const profile = defineProfile({\n  type: 'text',\n  id: 'p',\n  turnBehaviour: {\n    allowSteering: 'no',\n  },\n});\n`;
  const read = readStudioSource(source, createBlankDraft());
  assert(!read.ok);
  assertEquals(read.errors[0]?.line, 6);
});
