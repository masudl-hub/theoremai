import { assertEquals, assertThrows } from '@std/assert';
import registerExample from '../../studio/server/example.ts';
import { createStudioHandler, type StudioDescription } from '../../studio/server/handler.ts';
import { readProjectSource } from '../../studio/server/project-source.ts';
import { projectDiffers, projectNames, saveSubjects } from '../../studio/server/save.ts';
import {
  applyEdits,
  diffHunks,
  planSave,
  type SaveSubject,
} from '../../studio/server/save-plan.ts';
import { setToolAllowed } from '../../studio/workspace.ts';

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

Deno.test('a constant is not written: the plan names it and the file that holds it', () => {
  const files = {
    'setup.ts': `import { defineProfile } from '@theoremjs/agents';
import { DESK_ID, LIMITS } from './shared.ts';
const STEPS = 8;
defineProfile({ type: 'text', id: DESK_ID, maxSteps: STEPS, guardrails: LIMITS, system: build() });
`,
    'shared.ts': `export const DESK_ID = 'desk';\nexport const LIMITS = {\n  blockedReply: 'refuse',\n};\n`,
  };
  const before = {
    type: 'text',
    id: 'desk',
    maxSteps: 8,
    guardrails: { blockedReply: 'refuse' },
    system: 'a',
  };
  const { plan } = saved(files, before, {
    ...before,
    maxSteps: 9,
    guardrails: { blockedReply: 'ask' },
    system: 'b',
  });
  assertEquals(plan.edits, []);
  assertEquals(
    plan.changes.map(({ setting, status, name, file, line }) => [
      setting,
      status,
      name,
      file,
      line,
    ]),
    [
      ['maxSteps', 'constant', 'STEPS', '/project/setup.ts', 3],
      ['guardrails', 'constant', 'LIMITS', '/project/shared.ts', 2],
      ['system', 'code', undefined, '/project/setup.ts', 4],
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

Deno.test('a profile or tool the studio added or removed is named, not written', () => {
  const { workspace } = opened;
  const [agent] = workspace.agents;
  if (!agent) throw new Error('The example changed.');
  const subjects = saveSubjects(workspace, {
    profiles: ['other'],
    tools: projectNames(workspace).tools,
  });
  assertEquals(subjects.ok && subjects.changes.map(({ of, status }) => [of, status]), [
    ['garden-desk', 'new'],
    ['other', 'removed'],
  ]);
});
