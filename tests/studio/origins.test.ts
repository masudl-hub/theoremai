import { assertEquals } from '@std/assert';
import { defaultModelBinding } from '../../studio/draft.ts';
import { createExampleDraft } from '../../studio/example.ts';
import {
  nodeOrigins,
  openOutcome,
  originAt,
  originLabel,
  originPlace,
  rowOrigin,
  settingPath,
} from '../../studio/origins.ts';
import { sourceOrigins } from '../../studio/server/origins.ts';
import { readProjectSource } from '../../studio/server/project-source.ts';
import { planSave } from '../../studio/server/save-plan.ts';
import type { SettingOrigin } from '../../studio/server/save-wire.ts';
import { modelBindingNodeId, toolSpecNodeId } from '../../studio/tree.ts';
import { addAgent, agentNodeId, workspaceFromDraft } from '../../studio/workspace.ts';

const ROOT = '/project';

/** A project held in memory: its files by path under `/project`. */
function project(files: Record<string, string>) {
  const held = new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text]));
  return readProjectSource(`${ROOT}/setup.ts`, ROOT, (path) => held.get(path));
}

/** Each origin as `path kind text @file:line`, with the file from the project's folder. */
function read(files: Record<string, string>, kind: 'profiles' | 'tools' = 'profiles', of = 'desk') {
  return (sourceOrigins(project(files))[kind][of] ?? []).map((origin) =>
    [
      origin.path.join('.') || '(all)',
      origin.kind,
      origin.text,
      `${origin.file?.replace(`${ROOT}/`, '')}:${String(origin.line)}`,
      ...(origin.written ? [origin.written.join(',')] : []),
    ].join(' | '),
  );
}

const SETUP = `import { defineProfile, registerTool } from '@theoremjs/agents';
import { z } from 'zod';
import { BASE_GUARDRAILS, LIMITS, MODELS, READ } from './shared.ts';
import { deskInputs } from './inputs.ts';

const PLAN = Deno.env.get('PLAN') ?? 'free';

export const desk = defineProfile({
  type: 'text',
  id: 'desk',
  maxSteps: 8,
  system: ['Help the visitor.', 'Be brief.'].join('\\n'),
  identity: { handle: \`desk-\${PLAN}\` },
  inputs: deskInputs({ files: true }),
  models: { fast: { provider: 'openAi', apiId: modelFor(PLAN) }, slow: MODELS.slow },
  tools: { allow: ['list', READ, pick()] },
  guardrails: { ...BASE_GUARDRAILS, quota: LIMITS, blockedReply: 'refuse' },
  outputs: { streaming: { mode: 'tokens' }, ...extra, validation: { maxRetries: 2 } },
});

registerTool({
  name: 'list',
  description: 'Lists the plants.',
  access: READ,
  input: z.object({}),
  handler: () => [],
});
`;

const SHARED = `export const READ = 'read-only';
export const MODELS = { slow: { provider: 'openAi', apiId: 'gpt-slow', timeoutMs: seconds(30) } };
export const BASE_GUARDRAILS = { network: { allowedHosts: ['example.com'] } };
export const LIMITS = { perDay: 50 };
console.log(LIMITS);
`;

const FILES = {
  'setup.ts': SETUP,
  'shared.ts': SHARED,
  'inputs.ts': 'export const deskInputs = () => ({});\n',
};

Deno.test('each setting the files set in code is read once, at the key that holds it, with its place', () => {
  assertEquals(read(FILES), [
    'outputs.streaming | code | ...extra | setup.ts:18',
    'outputs | spread | ...extra | setup.ts:18 | validation',
    'guardrails.quota | constant | LIMITS | shared.ts:4',
    'guardrails | spread | ...BASE_GUARDRAILS | setup.ts:17 | quota,blockedReply',
    'tools.allow.2 | code | pick() | setup.ts:16',
    'models.slow.timeoutMs | code | seconds(30) | shared.ts:2',
    'models.fast.apiId | code | modelFor(PLAN) | setup.ts:15',
    'inputs | code | deskInputs({ files: true }) | setup.ts:14',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text a file holds
    'identity.handle | code | `desk-${PLAN}` | setup.ts:13',
  ]);
});

Deno.test('a tool sets its schemas and its handler in code', () => {
  assertEquals(read(FILES, 'tools', 'list'), [
    'handler | code | () => [] | setup.ts:26',
    'inputSchema | code | input: z.object({}) | setup.ts:25',
  ]);
});

Deno.test('a profile the files define twice is one origin, and a plain one has none', () => {
  const twice = `defineProfile({ id: 'desk', maxSteps: 1 });\ndefineProfile({ id: 'desk', maxSteps: 2 });\n`;
  assertEquals(read({ 'setup.ts': twice }), ['(all) | twice |  | setup.ts:1']);
  const plain = `defineProfile({ id: 'desk', maxSteps: 1, tools: { allow: ['a'] } });\n`;
  assertEquals(sourceOrigins(project({ 'setup.ts': plain })), { profiles: {}, tools: {} });
});

Deno.test('Save refuses a change wherever the reader finds an origin, and writes one where it finds none', () => {
  const source = project(FILES);
  const before = {
    type: 'text',
    id: 'desk',
    maxSteps: 8,
    identity: { handle: 'desk-free' },
    inputs: { text: true },
    models: {
      fast: { provider: 'openAi', apiId: 'gpt-fast' },
      slow: { provider: 'openAi', apiId: 'gpt-slow', timeoutMs: 30_000 },
    },
    tools: { allow: ['list', 'read-only', 'picked'] },
    guardrails: {
      network: { allowedHosts: ['example.com'] },
      quota: { perDay: 50 },
      blockedReply: 'refuse',
    },
    outputs: { streaming: { mode: 'tokens' }, validation: { maxRetries: 2 } },
  };
  const status = (after: unknown) =>
    planSave(source, [{ kind: 'profile', of: 'desk', before, after }]).changes.map(
      (change) => `${change.setting}: ${change.status}`,
    );
  const at = (path: string) =>
    originAt(sourceOrigins(source).profiles.desk ?? [], path.split('.'))?.kind;
  /** A row's path, the edit to it, and what Save says of it: the setting it names is the one the origin is at. */
  const cases: [string, unknown, string][] = [
    ['maxSteps', { ...before, maxSteps: 9 }, 'maxSteps: written'],
    ['identity.handle', { ...before, identity: { handle: 'front' } }, 'identity.handle: code'],
    ['inputs.text', { ...before, inputs: { text: false } }, 'inputs: code'],
    [
      'models.fast.apiId',
      { ...before, models: { ...before.models, fast: { provider: 'openAi', apiId: 'x' } } },
      'models.fast.apiId: code',
    ],
    [
      'models.fast.provider',
      { ...before, models: { ...before.models, fast: { provider: 'gemini', apiId: 'gpt-fast' } } },
      'models.fast.provider: written',
    ],
    [
      'models.slow.apiId',
      { ...before, models: { ...before.models, slow: { ...before.models.slow, apiId: 'x' } } },
      'models.slow.apiId: written',
    ],
    [
      'models.slow.timeoutMs',
      { ...before, models: { ...before.models, slow: { ...before.models.slow, timeoutMs: 1 } } },
      'models.slow.timeoutMs: code',
    ],
    [
      'tools.allow.2',
      { ...before, tools: { allow: ['list', 'read-only', 'other'] } },
      'tools.allow.2: code',
    ],
    [
      'guardrails.quota.perDay',
      { ...before, guardrails: { ...before.guardrails, quota: { perDay: 9 } } },
      'guardrails.quota: constant',
    ],
    [
      'guardrails.blockedReply',
      { ...before, guardrails: { ...before.guardrails, blockedReply: 'retry' } },
      'guardrails.blockedReply: written',
    ],
    [
      'guardrails.taint',
      { ...before, guardrails: { ...before.guardrails, taint: {} } },
      'guardrails.taint: code',
    ],
    [
      'outputs.streaming.mode',
      { ...before, outputs: { ...before.outputs, streaming: { mode: 'off' } } },
      'outputs.streaming: code',
    ],
    [
      'outputs.validation.maxRetries',
      { ...before, outputs: { ...before.outputs, validation: { maxRetries: 3 } } },
      'outputs.validation.maxRetries: written',
    ],
  ];
  for (const [path, after, expected] of cases) {
    assertEquals(status(after), [expected], path);
    assertEquals(at(path) !== undefined, !expected.endsWith(': written'), path);
  }
});

const origin = (path: string, over: Partial<SettingOrigin> = {}): SettingOrigin => ({
  path: path ? path.split('.') : [],
  kind: 'code',
  text: 'made()',
  file: 'setup.ts',
  line: 3,
  ...over,
});

Deno.test('a row is set in code by the nearest origin at or above it, or by one inside its list', () => {
  const origins = [
    origin('inputs'),
    origin('inputs.slots', { text: 'slots()' }),
    origin('guardrails', { kind: 'spread', written: ['quota'] }),
    origin('tools.allow.1'),
    origin('models.fast.apiId'),
  ];
  const at = (path: string) => originAt(origins, path.split('.'))?.path.join('.');
  assertEquals(['inputs.text', 'inputs.slots.0', 'inputs', 'maxSteps'].map(at), [
    'inputs',
    'inputs.slots',
    'inputs',
    undefined,
  ]);
  assertEquals(
    ['guardrails', 'guardrails.taint', 'guardrails.quota', 'guardrails.quota.perDay'].map(at),
    ['guardrails', 'guardrails', undefined, undefined],
  );
  assertEquals(['tools.allow', 'tools', 'models.fast', 'models.fast.provider'].map(at), [
    'tools.allow.1',
    undefined,
    undefined,
    undefined,
  ]);
});

Deno.test('a row path names the keys the files hold: a star the node names, a tool key, never a studio row', () => {
  const model = { stars: { 'models.*': 'gpt-4.1' }, tool: false };
  assertEquals(settingPath(model, 'models.*.providerOptions.cache.mode'), [
    'models',
    'gpt-4.1',
    'providerOptions',
    'cache',
    'mode',
  ]);
  assertEquals(settingPath(model, 'models.*.efforts.*'), ['models', 'gpt-4.1', 'efforts']);
  assertEquals(settingPath({ stars: {}, tool: false }, 'models.*.apiId'), ['models']);
  assertEquals(settingPath(model, 'studio.stubOutput'), undefined);
  const tool = { stars: {}, tool: true };
  assertEquals(
    ['registerTool.type', 'studio.inputSchema', 'studio.sampleInput', 'auth.slot'].map((path) =>
      settingPath(tool, path),
    ),
    [['type'], ['inputSchema'], undefined, ['auth', 'slot']],
  );
});

Deno.test('the open node reads the origins of the profile or tool it started as, and none when it is new', () => {
  const example = createExampleDraft();
  const binding = defaultModelBinding({ modelId: 'fast' });
  const desk = {
    ...example,
    identity: { ...example.identity, agentId: 'desk' },
    modelBindings: [binding],
    toolSpecs: [],
  };
  const opened = workspaceFromDraft(desk);
  const [agent] = opened.agents;
  if (!agent) throw new Error('No agent.');
  const origins = {
    profiles: {
      desk: [
        origin('inputs'),
        origin('models.fast.apiId'),
        origin('guardrails', { kind: 'spread' as const, written: [] }),
      ],
    },
    tools: {},
  };
  const at = (inner: string, workspace = opened) =>
    nodeOrigins(workspace, origins, agentNodeId(agent.key, inner));

  assertEquals(at('inputs')?.section?.path, ['inputs']);
  assertEquals(rowOrigin(at('inputs'), 'inputs.maxFiles')?.path, ['inputs']);
  // A spread leaves the section open, and is said once over the rows it sets.
  const guarded = at('guardrails');
  assertEquals(
    [
      guarded?.section,
      guarded?.partly?.kind,
      rowOrigin(guarded, 'guardrails.quota') === guarded?.partly,
    ],
    [undefined, 'spread', true],
  );
  const model = at(modelBindingNodeId(binding.key));
  assertEquals([model?.section, model?.stars], [undefined, { 'models.*': 'fast' }]);
  assertEquals(rowOrigin(model, 'models.*.apiId')?.path, ['models', 'fast', 'apiId']);
  assertEquals(rowOrigin(model, 'models.*.provider'), undefined);

  // Renamed in the studio, it is still the profile and the model the files hold.
  const renamed = {
    ...opened,
    agents: [
      {
        ...agent,
        identity: { ...agent.identity, agentId: 'front' },
        modelBindings: [{ ...binding, modelId: 'quick' }],
      },
    ],
  };
  assertEquals(rowOrigin(at(modelBindingNodeId(binding.key), renamed), 'models.*.apiId')?.path, [
    'models',
    'fast',
    'apiId',
  ]);

  // One added in the studio is in no file.
  const added = addAgent(opened, { ...desk, identity: { ...desk.identity, agentId: 'yard' } });
  const yard = added.agents.find((each) => each.identity.agentId === 'yard');
  assertEquals(yard && nodeOrigins(added, origins, agentNodeId(yard.key, 'inputs')), undefined);
  assertEquals(nodeOrigins(opened, origins, toolSpecNodeId('none')), undefined);
  assertEquals(rowOrigin(undefined, 'inputs.text'), undefined);
});

Deno.test('a whole profile or tool the studio cannot write says so over every section', () => {
  const example = createExampleDraft();
  const opened = workspaceFromDraft({
    ...example,
    identity: { ...example.identity, agentId: 'desk' },
  });
  const [agent] = opened.agents;
  const [tool] = opened.toolSpecs;
  if (!agent) throw new Error('No agent.');
  const twice = origin('', { kind: 'twice', text: undefined });
  const origins = {
    profiles: { desk: [twice] },
    tools: tool
      ? {
          [tool.toolName]: [
            origin('inputSchema'),
            origin('', { kind: 'unfound', file: undefined, line: undefined }),
          ],
        }
      : {},
  };
  assertEquals(nodeOrigins(opened, origins, agentNodeId(agent.key, 'inputs'))?.section, twice);
  if (tool) {
    const scope = nodeOrigins(opened, origins, toolSpecNodeId(tool.key));
    assertEquals([scope?.tool, scope?.section?.kind], [true, 'unfound']);
  }
});

Deno.test('an origin reads as what set the value and where', () => {
  assertEquals(
    [
      origin('a'),
      origin('a', { kind: 'spread', text: '...BASE' }),
      origin('a', { text: undefined }),
    ].map(originLabel),
    ['Set in code · made()', 'Set in code · ...BASE', 'Set in code'],
  );
  assertEquals(
    [
      origin('a', { kind: 'constant', text: 'LIMITS' }),
      origin('', { kind: 'twice' }),
      origin('', { kind: 'unfound' }),
    ].map(originLabel),
    [
      'Set by LIMITS, which other code reads',
      'Defined more than once in your files',
      'The studio could not find where your files define this',
    ],
  );
  assertEquals(
    [origin('a'), origin('a', { line: undefined }), origin('a', { file: undefined })].map(
      originPlace,
    ),
    ['setup.ts:3', 'setup.ts', undefined],
  );
});

Deno.test('an Open the builder asked for says what happened, and how to name an editor when none started', () => {
  const how =
    'Start the studio with --editor and the command of an editor that opens a window: code, cursor, zed.';
  const said = (answer: Parameters<typeof openOutcome>[0]) => openOutcome(answer, 'setup.ts:4');
  assertEquals(
    [
      said({ ok: true, editor: 'code' }),
      said({ ok: false, reason: 'file' }),
      said({ ok: false, reason: 'editor', editor: 'vim' }),
      said({ ok: false, reason: 'editor', editor: '' }),
      said({ ok: false, reason: 'failed', editor: 'code' }),
      said({ ok: false, reason: 'failed' }),
    ],
    [
      'Opened setup.ts:4 in code.',
      'setup.ts:4 is not a file your setup reads now. Reload the studio.',
      `The studio cannot start vim on a line. ${how}`,
      `The studio cannot start that editor on a line. ${how}`,
      `code did not start. ${how}`,
      `Your editor did not start. ${how}`,
    ],
  );
});

Deno.test("a decision's questions are set where the setup module exports them", () => {
  const source = project({
    'setup.ts': `import { defineProfile } from '@theoremjs/agents';
export const questions = {
  other: {},
  desk: { next: { type: 'noul', instructions: 'How sure?' } },
};
defineProfile({ type: 'decision', id: 'desk' });
`,
  });
  assertEquals(sourceOrigins(source, ['desk']).profiles.desk, [
    {
      path: ['decision', 'questions'],
      kind: 'code',
      text: 'export const questions',
      file: `${ROOT}/setup.ts`,
      line: 4,
    },
  ]);
  assertEquals(sourceOrigins(source).profiles.desk, undefined);
});

Deno.test('questions the setup module exports another way are set in code, with no place', () => {
  const source = project({
    'setup.ts': `import { questions } from './asked.ts';\nexport { questions };\n`,
    'asked.ts': 'export const questions = {};\n',
  });
  assertEquals(sourceOrigins(source, ['desk']).profiles.desk, [
    { path: ['decision', 'questions'], kind: 'code', text: 'export const questions' },
  ]);
});
