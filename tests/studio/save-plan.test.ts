import { assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import { jsonSchemaFromZod } from '../../src/kernel/tools/schema.ts';
import { defaultToolSpec } from '../../studio/draft.ts';
import registerExample from '../../studio/server/example.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import {
  readableName,
  readProjectSource,
  sharedSettings,
} from '../../studio/server/project-source.ts';
import { projectDiffers, projectNames, saveSubjects } from '../../studio/server/save.ts';
import {
  applyEdits,
  diffHunks,
  planSave,
  type SaveSubject,
} from '../../studio/server/save-plan.ts';
import { setToolAllowed, startedHere } from '../../studio/workspace.ts';

const ROOT = '/project';

/** A project held in memory: its files by path under `/project`. */
function project(files: Record<string, string>) {
  const held = new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text]));
  return readProjectSource(`${ROOT}/setup.ts`, ROOT, (path) => held.get(path));
}

/** Plans one profile's change and returns the file as Save would write it, with each change's status. */
function saved(files: Record<string, string>, before: unknown, after: unknown, file = 'setup.ts') {
  const source = project(files);
  const subject: SaveSubject = { kind: 'profile', of: 'desk', before, after };
  const plan = planSave(source, [subject]);
  const path = `${ROOT}/${file}`;
  const text = applyEdits(
    files[file] ?? '',
    plan.edits.filter((edit) => edit.file === path),
  );
  return {
    text,
    statuses: plan.changes.map((change) => `${change.setting}: ${change.status}`),
    plan,
  };
}

const INLINE = `import { defineProfile } from '@theoremjs/agents';

export const desk = defineProfile({
  type: 'text',
  id: 'desk',
  maxSteps: 8,
  system: "Help the visitor.",
  tools: { allow: ['list'] },
  guardrails: {
    blockedReply: 'refuse', // what the visitor reads
  },
});
`;

const BASE = {
  type: 'text',
  id: 'desk',
  maxSteps: 8,
  system: 'Help the visitor.',
  tools: { allow: ['list'] },
  guardrails: { blockedReply: 'refuse' },
};

Deno.test('a value written in the profile is rewritten where it stands, and nothing else moves', () => {
  const { text, statuses } = saved({ 'setup.ts': INLINE }, BASE, { ...BASE, maxSteps: 12 });
  assertEquals(statuses, ['maxSteps: written']);
  assertEquals(text, INLINE.replace('maxSteps: 8', 'maxSteps: 12'));
});

Deno.test('text keeps the quotes the file uses, and text of several lines becomes a template', () => {
  const one = saved({ 'setup.ts': INLINE }, BASE, { ...BASE, system: `Say "hi".` });
  assertEquals(one.text.includes('system: "Say \\"hi\\".",'), true);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the text under test holds a placeholder
  const many = saved({ 'setup.ts': INLINE }, BASE, { ...BASE, system: 'Line one.\nCost: `${n}`' });
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the text under test holds a placeholder
  assertEquals(many.text.includes('system: `Line one.\nCost: \\`\\${n}\\``,'), true);
});

Deno.test('a list that grows is rewritten whole; one whose length holds changes item by item', () => {
  const grown = saved({ 'setup.ts': INLINE }, BASE, { ...BASE, tools: { allow: ['list', 'log'] } });
  assertEquals(grown.statuses, ['tools.allow: written']);
  assertEquals(grown.text.includes("tools: { allow: ['list', 'log'] },"), true);
  const swapped = saved({ 'setup.ts': INLINE }, BASE, { ...BASE, tools: { allow: ['log'] } });
  assertEquals(swapped.statuses, ['tools.allow.0: written']);
  assertEquals(swapped.text.includes("tools: { allow: ['log'] },"), true);
});

Deno.test("a setting the file never wrote is added after the last one, in the file's own indentation", () => {
  const top = saved({ 'setup.ts': INLINE }, BASE, {
    ...BASE,
    handle: 'desk',
    models: { fast: { apiId: 'x' } },
  });
  assertEquals(top.statuses, ['handle: written', 'models: written']);
  assertEquals(
    top.text.includes(
      "  },\n  handle: 'desk',\n  models: {\n    fast: {\n      apiId: 'x',\n    },\n  },\n});",
    ),
    true,
  );
  const nested = saved({ 'setup.ts': INLINE }, BASE, {
    ...BASE,
    guardrails: { blockedReply: 'refuse', canary: true },
  });
  assertEquals(
    nested.text.includes(
      "    blockedReply: 'refuse', // what the visitor reads\n    canary: true,\n  },",
    ),
    true,
  );
  const inline = saved({ 'setup.ts': INLINE }, BASE, {
    ...BASE,
    tools: { allow: ['list'], loader: 'find' },
  });
  assertEquals(inline.text.includes("tools: { allow: ['list'], loader: 'find' },"), true);
});

Deno.test('a setting put back to its default is taken out with its comma', () => {
  const { maxSteps: _, ...without } = BASE;
  const { text, statuses } = saved({ 'setup.ts': INLINE }, BASE, without);
  assertEquals(statuses, ['maxSteps: written']);
  assertEquals(text, INLINE.replace('  maxSteps: 8,\n', ''));
});

const SHARED = `export const DESK_ID = 'desk';
export const LIMITS = {
  blockedReply: 'refuse',
};
const INNER = ['a'];
export const NESTED = { canaries: INNER };
`;
const USES = `import { defineProfile } from '@theoremjs/agents';
import { DESK_ID, LIMITS as RULES, NESTED } from './shared.ts';
const STEPS = 8;
defineProfile({ type: 'text', id: DESK_ID, maxSteps: STEPS, guardrails: RULES, nested: NESTED, system: build() });
`;
const USED = {
  type: 'text',
  id: 'desk',
  maxSteps: 8,
  guardrails: { blockedReply: 'refuse' },
  nested: { canaries: ['a'] },
  system: 'a',
};
const RESET = {
  ...USED,
  maxSteps: 9,
  guardrails: { blockedReply: 'ask' },
  nested: { canaries: ['b'] },
};

Deno.test('a constant only this profile reads is changed where it is set, in its own file', () => {
  const files = { 'setup.ts': USES, 'shared.ts': SHARED };
  const { plan, text } = saved(files, USED, { ...RESET, system: 'b' });
  assertEquals(
    plan.changes.map(({ setting, status, file, line }) => [setting, status, file, line]),
    [
      ['maxSteps', 'written', '/project/setup.ts', 3],
      ['guardrails.blockedReply', 'written', '/project/shared.ts', 3],
      ['nested.canaries.0', 'written', '/project/shared.ts', 5],
      ['system', 'code', '/project/setup.ts', 4],
    ],
  );
  assertEquals(text, USES.replace('STEPS = 8', 'STEPS = 9'));
  const shared = plan.edits.filter((edit) => edit.file === '/project/shared.ts');
  assertEquals(
    applyEdits(SHARED, shared),
    SHARED.replace("'refuse'", "'ask'").replace("['a']", "['b']"),
  );
});

Deno.test('a constant something else reads too is not written: the plan names it and who shares it', () => {
  const second = `import { defineProfile, registerTool } from '@theoremjs/agents';
import { LIMITS, NESTED } from './shared.ts';
import './setup.ts';
defineProfile({ type: 'text', id: 'shop', guardrails: LIMITS });
registerTool({ name: 'list', limits: { ...LIMITS } });
export const copy = () => NESTED.canaries.length;
`;
  const files = {
    'setup.ts': `${USES}import './second.ts';\n`,
    'shared.ts': SHARED,
    'second.ts': second,
  };
  const { plan } = saved(files, USED, RESET);
  assertEquals(
    plan.edits.map((edit) => [edit.file, edit.text]),
    [['/project/setup.ts', '9']],
  );
  assertEquals(
    plan.changes
      .slice(1)
      .map(({ setting, status, name, file, line, sharedWith, readByCode }) => [
        setting,
        status,
        name,
        file,
        line,
        sharedWith,
        readByCode,
      ]),
    [
      ['nested', 'constant', 'NESTED', '/project/shared.ts', 6, undefined, true],
      // Named as it is declared, not by the name this file imports it under.
      ['guardrails', 'constant', 'LIMITS', '/project/shared.ts', 2, ['shop', 'list'], undefined],
    ],
  );
});

const PAIR = `import { defineProfile } from '@theoremjs/agents';
import { STANDARD_GUARDRAILS, tone } from './shared.ts';
defineProfile({ type: 'text', id: 'desk', guardrails: STANDARD_GUARDRAILS, system: tone });
defineProfile({ type: 'text', id: 'shop', guardrails: STANDARD_GUARDRAILS as never, lexicon: { tone } });
`;
const PAIR_SHARED = `export const STANDARD_GUARDRAILS = {
  blockedReply: 'refuse',
};
export const tone = 'Be brief.';
export const pick = () => 1;
`;
const PAIR_FILES = { 'setup.ts': PAIR, 'shared.ts': PAIR_SHARED };
const guarded = (of: string, blockedReply: string): SaveSubject => ({
  kind: 'profile',
  of,
  before: { id: of, guardrails: { blockedReply: 'refuse' } },
  after: { id: of, guardrails: { blockedReply } },
});

Deno.test('a shared constant is written once when every profile that reads it makes the same change', () => {
  const plan = planSave(project(PAIR_FILES), [guarded('desk', 'ask'), guarded('shop', 'ask')]);
  assertEquals(
    plan.changes.map(({ of, setting, status }) => [of, setting, status]),
    [
      ['desk', 'guardrails.blockedReply', 'written'],
      ['shop', 'guardrails.blockedReply', 'written'],
    ],
  );
  assertEquals(plan.edits.length, 1);
  assertEquals(applyEdits(PAIR_SHARED, plan.edits), PAIR_SHARED.replace("'refuse'", "'ask'"));
});

Deno.test('a shared constant is left alone when a profile that reads it does not make the change, or makes another', () => {
  for (const subjects of [
    [guarded('desk', 'ask')],
    [guarded('desk', 'ask'), guarded('shop', 'repair')],
  ]) {
    const plan = planSave(project(PAIR_FILES), subjects);
    assertEquals(plan.edits, []);
    assertEquals(
      plan.changes.map(({ of, status, name, sharedWith }) => [of, status, name, sharedWith]),
      subjects.map(({ of }) => [
        of,
        'constant',
        'STANDARD_GUARDRAILS',
        [of === 'desk' ? 'shop' : 'desk'],
      ]),
    );
  }
});

Deno.test('the shared settings are the constants more than one profile or tool reads, with the key each fills', () => {
  const tools = `import { registerTool } from '@theoremjs/agents';
import { STANDARD_GUARDRAILS } from './shared.ts';
registerTool({ name: 'list', limits: STANDARD_GUARDRAILS });
`;
  assertEquals(sharedSettings(project(PAIR_FILES)), [
    {
      name: 'STANDARD_GUARDRAILS',
      label: 'Standard guardrails',
      file: '/project/shared.ts',
      line: 1,
      key: 'guardrails',
      profiles: ['desk', 'shop'],
      tools: [],
      readByCode: false,
    },
    // Read under two keys, one of them inside a value: listed, and changed in the editor.
    {
      name: 'tone',
      label: 'Tone',
      file: '/project/shared.ts',
      line: 4,
      profiles: ['desk', 'shop'],
      tools: [],
      readByCode: false,
    },
  ]);
  const withTool = sharedSettings(
    project({ ...PAIR_FILES, 'setup.ts': `${PAIR}import './tools.ts';\n`, 'tools.ts': tools }),
  );
  assertEquals(
    withTool.map(({ name, key, tools: used }) => [name, key, used]),
    [
      ['STANDARD_GUARDRAILS', undefined, ['list']],
      ['tone', undefined, []],
    ],
  );
  assertEquals(
    [readableName('standardGuardrails'), readableName('HTTP_LIMITS_V2')],
    ['Standard guardrails', 'Http limits v2'],
  );
});

Deno.test('a name the project does not set is named and left alone', () => {
  const files = {
    'setup.ts': `import { STEPS } from 'some-package';\nexport const make = (limits) => defineProfile({ id: 'desk', maxSteps: STEPS, guardrails: limits });\n`,
  };
  const before = { id: 'desk', maxSteps: 8, guardrails: { blockedReply: 'refuse' } };
  const { plan } = saved(files, before, {
    id: 'desk',
    maxSteps: 9,
    guardrails: { blockedReply: 'ask' },
  });
  assertEquals(plan.edits, []);
  assertEquals(
    plan.changes.map(({ setting, status, name }) => [setting, status, name]),
    [
      ['maxSteps', 'constant', 'STEPS'],
      ['guardrails', 'constant', 'limits'],
    ],
  );
});

Deno.test('a value a spread may set, a file that moved on, and a profile no file defines are not written', () => {
  const spread = `defineProfile({ id: 'desk', maxSteps: 8, ...rest });\n`;
  const before = { id: 'desk', maxSteps: 8, handle: 'a' };
  assertEquals(
    saved({ 'setup.ts': spread }, before, { id: 'desk', maxSteps: 9, handle: 'b' }).statuses,
    ['maxSteps: code', 'handle: code'],
  );
  assertEquals(saved({ 'setup.ts': INLINE }, { ...BASE, maxSteps: 4 }, BASE).statuses, [
    'maxSteps: changed',
  ]);
  assertEquals(saved({ 'setup.ts': `export {};\n` }, BASE, { ...BASE, maxSteps: 9 }).statuses, [
    ': unfound',
  ]);
  const twice = `defineProfile({ id: 'desk', maxSteps: 8 });\ndefineProfile({ id: 'desk', maxSteps: 8 });\n`;
  assertEquals(saved({ 'setup.ts': twice }, before, { ...before, maxSteps: 9 }).statuses, [
    ': code',
  ]);
});

Deno.test("a tool's schema is its code: the plan points at it and writes the rest", () => {
  const files = {
    'setup.ts': `registerTool({\n\tname: 'list',\n\tdescription: 'Lists.',\n\tinput: z.object({}),\n});\n`,
  };
  const before = { name: 'list', description: 'Lists.', inputSchema: { type: 'object' } };
  const after = { name: 'list', description: 'Lists plants.', inputSchema: { type: 'string' } };
  const plan = planSave(project(files), [{ kind: 'tool', of: 'list', before, after }]);
  assertEquals(
    plan.changes.map(({ setting, status, line }) => [setting, status, line]),
    [
      ['description', 'written', 3],
      ['inputSchema', 'code', 4],
    ],
  );
  assertEquals(
    applyEdits(files['setup.ts'], plan.edits).includes("\tdescription: 'Lists plants.',"),
    true,
  );
});

Deno.test('the diff shows each run of changed lines with the lines around it', () => {
  const { plan } = saved({ 'setup.ts': INLINE }, BASE, { ...BASE, maxSteps: 12, handle: 'desk' });
  assertEquals(diffHunks(INLINE, plan.edits), [
    {
      line: 6,
      lead: ["  type: 'text',", "  id: 'desk',"],
      removed: ['  maxSteps: 8,'],
      added: ['  maxSteps: 12,'],
      trail: ['  system: "Help the visitor.",', "  tools: { allow: ['list'] },"],
    },
    {
      line: 12,
      lead: ["    blockedReply: 'refuse', // what the visitor reads", '  },'],
      removed: [],
      added: ["  handle: 'desk',"],
      trail: ['});', ''],
    },
  ]);
  assertThrows(() =>
    applyEdits('abc', [
      { file: 'a', start: 0, end: 2, text: 'x' },
      { file: 'a', start: 1, end: 3, text: 'y' },
    ]),
  );
});

registerExample();
const opened: StudioDescription = await (
  await createStudioHandler({
    project: 'garden',
    pageOrigins: ['http://localhost:5174'],
    listenHost: '127.0.0.1:4983',
  })(new Request('http://127.0.0.1:4983/api/studio', { headers: { host: '127.0.0.1:4983' } }))
).json();

Deno.test('allowing a tool in the studio is one changed line in the project', () => {
  const { workspace } = opened;
  const names = projectNames(workspace);
  const agent = workspace.agents[0];
  const removal = workspace.toolSpecs.find((tool) => tool.toolName === 'remove_plant');
  if (!agent || !removal) throw new Error('The example changed.');
  const untouched = saveSubjects(workspace, names);
  assertEquals(untouched.ok && planSave(project({}), untouched.subjects).changes, []);

  const edited = setToolAllowed(workspace, agent.key, removal.key, true);
  const subjects = saveSubjects(edited, names);
  if (!subjects.ok) throw new Error(subjects.issues.join(' '));
  assertEquals(subjects.changes, []);
  const path = new URL('../../studio/server/example.ts', import.meta.url).pathname;
  const text = Deno.readTextFileSync(path);
  const source = readProjectSource(
    path,
    new URL('../../studio/server', import.meta.url).pathname,
    (file) => (file === path ? text : undefined),
  );
  const plan = planSave(source, subjects.subjects);
  assertEquals(
    plan.changes.map(({ of, setting, status }) => [of, setting, status]),
    [['garden-desk', 'tools.allow', 'written']],
  );
  assertEquals(
    diffHunks(text, plan.edits).map(({ removed, added }) => [removed, added]),
    [
      [
        ["      tools: { allow: ['list_plants', 'log_watering'] },"],
        ["      tools: { allow: ['list_plants', 'log_watering', 'remove_plant'] },"],
      ],
    ],
  );
  assertEquals(projectDiffers(workspace, edited), ['garden-desk', 'remove_plant']);
  assertEquals(projectDiffers(edited, edited), []);
});

Deno.test('a tool the studio added is compared as the kernel reads its schema', () => {
  const { workspace } = opened;
  const input = {
    type: 'object',
    properties: {
      bed: { type: 'string', enum: ['north', 'south'], description: 'Which bed to count.' },
      since: { type: 'string', format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    required: ['bed'],
    additionalProperties: false,
  };
  const added = defaultToolSpec({
    toolName: 'count_plants',
    description: 'Counts the plants in a bed.',
    inputJson: JSON.stringify(input, null, 2),
  });
  const [agent] = workspace.agents;
  if (!agent) throw new Error('The example changed.');
  const allowed = (held: typeof workspace) => setToolAllowed(held, agent.key, added.key, true);
  const tested = allowed({ ...workspace, toolSpecs: [...workspace.toolSpecs, added] });
  // The files as they load after Save: the kernel reads the schema back from the new tool's file.
  const read = (schema: unknown, side: 'input' | 'output') =>
    JSON.stringify(jsonSchemaFromZod(z.fromJSONSchema(schema as never), side));
  const loadedAs = (schema: unknown) => {
    const tool = {
      ...added,
      inputJson: read(schema, 'input'),
      outputJson: read(JSON.parse(added.outputJson), 'output'),
    };
    return allowed({ ...workspace, toolSpecs: [...workspace.toolSpecs, tool] });
  };
  assertEquals(projectDiffers(loadedAs(input), tested), []);
  // After that Save the page still holds the schema as the builder wrote it, and saves again.
  assertEquals(projectDiffers(loadedAs(input), startedHere(tested)), []);

  // A file that lost a limit the builder tested is not what was tested.
  const { maximum: _, ...unbounded } = input.properties.limit;
  const looser = { ...input, properties: { ...input.properties, limit: unbounded } };
  assertEquals(projectDiffers(loadedAs(looser), tested), ['count_plants']);
});

Deno.test('a profile the studio added is one to write, and one it removed is named, not written', () => {
  const { workspace } = opened;
  const [agent] = workspace.agents;
  if (!agent) throw new Error('The example changed.');
  const subjects = saveSubjects(workspace, {
    profiles: ['other'],
    tools: projectNames(workspace).tools,
  });
  assertEquals(
    subjects.ok && [
      subjects.added.profiles,
      subjects.changes.map(({ of, status }) => [of, status]),
    ],
    [['garden-desk'], [['other', 'removed']]],
  );
});

Deno.test('Save rewrites complete literal values and joined text without evaluating expressions', () => {
  for (const [expression, value] of [
    ['-3', -3],
    ['true', true],
    ['false', false],
    ['null', null],
    ['[1, "two", null]', [1, 'two', null]],
    ['{ nested: [true, -2] }', { nested: [true, -2] }],
    ['["one", "two"].join("\\n")', 'one\ntwo'],
  ] as const) {
    const source = `defineProfile({ id: 'desk', value: ${expression} });`;
    const result = saved(
      { 'setup.ts': source },
      { id: 'desk', value },
      { id: 'desk', value: 'replacement' },
    );
    assertEquals(result.statuses, ['value: written'], expression);
    assertEquals(result.text.includes("value: 'replacement'"), true, expression);
  }
  for (const expression of [
    '[...values]',
    '{ ...values }',
    '{ shorthand }',
    '{ method() {} }',
    '{ [computed]: 1 }',
    '[unknown].join("-")',
    '[1].join("-")',
    '["one"].join(unknown)',
    'readValue()',
    '1 + 2',
  ]) {
    const source = `defineProfile({ id: 'desk', value: ${expression} });`;
    const result = saved(
      { 'setup.ts': source },
      { id: 'desk', value: 'before' },
      { id: 'desk', value: 'replacement' },
    );
    assertEquals(result.statuses, ['value: code'], expression);
    assertEquals(result.text, source, expression);
  }
});
