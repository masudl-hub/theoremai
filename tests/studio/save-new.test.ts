import { assertEquals } from '@std/assert';
import type { CompiledStudio } from '../../studio/compile.ts';
import type { ToolRegistration } from '../../studio/registrations.ts';
import { readProjectSource } from '../../studio/server/project-source.ts';
import { type NewSubjects, planNew } from '../../studio/server/save-new.ts';
import { applyEdits } from '../../studio/server/save-plan.ts';

const ROOT = '/project';

/** Plans what was added to a project held in memory, and returns each file as Save would write it. */
function planned(files: Record<string, string>, added: NewSubjects, entry = 'setup.ts') {
  const held = new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text]));
  const source = readProjectSource(`${ROOT}/${entry}`, ROOT, (path) => held.get(path));
  const plan = planNew(source, added, (path) => held.has(path));
  const written: Record<string, string> = {};
  for (const [file, edits] of Map.groupBy(plan.edits, (edit) => edit.file)) {
    written[file.replace(`${ROOT}/`, '')] = applyEdits(held.get(file) ?? '', edits);
  }
  return {
    written,
    statuses: plan.changes.map(({ of, status, file }) => [
      of,
      status,
      file?.replace(`${ROOT}/`, ''),
    ]),
  };
}

function host(id: string, allow: string[], customTools: ToolRegistration[] = []): CompiledStudio {
  return { agentId: id, profile: { type: 'host', id, tools: { allow } }, customTools };
}

const COMMON = {
  category: 'plants',
  access: 'read-only',
  permission: 'auto',
  loadTier: 'T0',
} as const;
const OBJECT = { type: 'object', properties: {} };

function counts(name: string): ToolRegistration {
  return {
    type: 'function',
    name,
    description: 'Counts.',
    ...COMMON,
    paths: ['*'],
    inputSchema: OBJECT,
    outputSchema: { type: 'object', properties: { n: { type: 'number' } } },
  };
}

function asks(name: string, profile: string): ToolRegistration {
  return {
    type: 'agent',
    name,
    description: 'Asks.',
    ...COMMON,
    paths: ['*'],
    profile,
    inputSchema: OBJECT,
    outputSchema: OBJECT,
  };
}

const LIST =
  "registerTool({ type: 'function', name: 'list', description: 'Lists.', access: 'read-only', paths: ['*'], input: z.object({}), output: z.object({}), handler: () => ({}) });";
const DESK = "defineProfile({ type: 'host', id: 'desk', tools: { allow: ['list'] } })";

const INLINE = `import { defineProfile, registerProfile, registerTool, z } from '@theoremjs/agents';

export default function register() {
  ${LIST}
  registerProfile(${DESK});
}
`;

/** A project with a folder for its agents and one for its tools, the kernel by a path, and no extensions. */
const SPLIT = {
  'setup.ts': `import { registerProfile } from '../kernel/mod';
import { desk } from './agents/desk';
import { front } from './agents/front';
import { registerList } from './tools/list';

registerList();
registerProfile(desk);
registerProfile(front);
`,
  'agents/desk.ts': `import { defineProfile } from '../../kernel/mod';
export const desk = ${DESK};
`,
  'agents/front.ts': `import { defineProfile } from '../../kernel/mod';
export const front = defineProfile({ type: 'host', id: 'front', tools: { allow: ['list'] } });
`,
  'tools/list.ts': `import { z } from 'zod';
import { registerTool } from '../../kernel/mod';
export function registerList() {
  ${LIST}
}
`,
};

Deno.test('a new tool and a new agent are each a file, registered where the order holds', () => {
  const count = counts('count_plants');
  const second = host('second-desk', ['list', 'count_plants'], [count]);
  const { written, statuses } = planned(
    { 'setup.ts': INLINE },
    { agents: [host('desk', ['list']), second], profiles: ['second-desk'], tools: [count] },
  );
  assertEquals(statuses, [
    ['count_plants', 'written', 'count_plants.ts'],
    ['second-desk', 'written', 'second-desk.ts'],
  ]);
  assertEquals(
    written['setup.ts'],
    `import { defineProfile, registerProfile, registerTool, z } from '@theoremjs/agents';
import { registerCountPlants } from './count_plants';
import * as secondDesk from './second-desk';

export default function register() {
  ${LIST}
  registerCountPlants();
  registerProfile(${DESK});
  registerProfile(secondDesk.profile);
}
`,
  );
  assertEquals(
    written['count_plants.ts'],
    `import { registerTool, z } from '@theoremjs/agents';

/**
 * Registers \`count_plants\`. Call it before any agent that allows it is registered.
 * Its handler returns the studio's sample answer: write the real one here.
 */
export function registerCountPlants(): void {
  registerTool({
    type: 'function',
    name: 'count_plants',
    description: 'Counts.',
    category: 'plants',
    access: 'read-only',
    permission: 'auto',
    loadTier: 'T0',
    paths: ['*'],
    input: z.fromJSONSchema({
      type: 'object',
      properties: {},
    }),
    output: z.fromJSONSchema({
      type: 'object',
      properties: {
        n: {
          type: 'number',
        },
      },
    }),
    handler: () => Promise.resolve({
      n: 0,
    }),
  });
}
`,
  );
  assertEquals(
    written['second-desk.ts'],
    `import { defineProfile } from '@theoremjs/agents';

export const profile = defineProfile({
  type: 'host',
  id: 'second-desk',
  tools: {
    allow: ['list', 'count_plants'],
  },
});
`,
  );
});

Deno.test("new files go in the project's own folders and import as its files do", () => {
  const count = counts('count_plants');
  const ask = asks('ask_desk', 'desk');
  const second: CompiledStudio = {
    ...host('second-desk', ['count_plants', 'ask_desk'], [count, ask]),
    structured: { id: 'second-reply', spec: { jsonSchema: OBJECT } },
  };
  const { written, statuses } = planned(SPLIT, {
    agents: [host('desk', ['list']), host('front', ['list']), second],
    profiles: ['second-desk'],
    tools: [count, ask],
  });
  assertEquals(statuses, [
    ['count_plants', 'written', 'tools/count_plants.ts'],
    ['second-desk', 'written', 'agents/second-desk.ts'],
    ['ask_desk', 'written', 'tools/ask_desk.ts'],
  ]);
  // The tool that calls an agent waits for the new agent that allows it, after the agent it runs.
  assertEquals(
    written['setup.ts'],
    `import { registerProfile, registerStructured } from '../kernel/mod';
import { desk } from './agents/desk';
import { front } from './agents/front';
import { registerList } from './tools/list';
import { registerCountPlants } from './tools/count_plants';
import * as secondDesk from './agents/second-desk';
import { registerAskDesk } from './tools/ask_desk';

registerList();
registerCountPlants();
registerProfile(desk);
registerProfile(front);
registerAskDesk();
registerStructured(secondDesk.structured.id, secondDesk.structured.spec);
registerProfile(secondDesk.profile);
`,
  );
  assertEquals(written['tools/count_plants.ts']?.split('\n').slice(0, 2), [
    "import { z } from 'zod';",
    "import { registerTool } from '../../kernel/mod';",
  ]);
  assertEquals(
    written['tools/ask_desk.ts'],
    `import { registerTool } from '../../kernel/mod';

/** Registers \`ask_desk\`. Call it after the agent it runs is registered, and before any agent that allows it. */
export function registerAskDesk(): void {
  registerTool({
    type: 'agent',
    name: 'ask_desk',
    description: 'Asks.',
    category: 'plants',
    access: 'read-only',
    permission: 'auto',
    loadTier: 'T0',
    paths: ['*'],
    profile: 'desk',
  });
}
`,
  );
  assertEquals(written['agents/second-desk.ts']?.split('\n').slice(0, 4), [
    "import { defineProfile } from '../../kernel/mod';",
    '',
    "/** The reply's shape, registered before the profile. */",
    'export const structured = {',
  ]);
});

Deno.test('a tool that calls an agent goes after that agent and before the agents that allow it', () => {
  const askDesk = asks('ask_desk', 'desk');
  const askSecond = asks('ask_second', 'second-desk');
  const agents = [
    host('desk', ['list']),
    host('front', ['list', 'ask_desk', 'ask_second'], [askDesk, askSecond]),
    host('second-desk', ['list']),
  ];
  const { written, statuses } = planned(SPLIT, {
    agents,
    profiles: ['second-desk'],
    tools: [askDesk, askSecond],
  });
  assertEquals(
    statuses.map(([of, status]) => [of, status]),
    [
      ['ask_desk', 'written'],
      ['second-desk', 'written'],
      ['ask_second', 'written'],
    ],
  );
  // The new agent comes before the agent that calls it, with the tool that runs it.
  assertEquals(written['setup.ts']?.split('\n').slice(8), [
    'registerList();',
    'registerProfile(desk);',
    'registerAskDesk();',
    'registerProfile(secondDesk.profile);',
    'registerAskSecond();',
    'registerProfile(front);',
    '',
  ]);

  // `desk` is registered before `front`, so a tool that runs `front` cannot come before `desk`.
  const askFront = asks('ask_front', 'front');
  const back = planned(SPLIT, {
    agents: [host('desk', ['list', 'ask_front'], [askFront]), host('front', ['list'])],
    profiles: [],
    tools: [askFront],
  });
  assertEquals([back.statuses, back.written], [[['ask_front', 'setup', 'setup.ts']], {}]);

  // A new agent that goes before one the project has cannot wait for a tool of its own.
  const both = planned(SPLIT, {
    agents: [
      host('desk', ['list']),
      host('front', ['list', 'ask_second'], [askSecond]),
      host('second-desk', ['ask_third'], [asks('ask_third', 'third')]),
      host('third', []),
    ],
    profiles: ['second-desk', 'third'],
    tools: [askSecond, asks('ask_third', 'third')],
  });
  assertEquals(
    both.statuses.map(([of, status]) => [of, status]),
    [
      ['third', 'written'],
      ['second-desk', 'written'],
      ['ask_third', 'setup'],
      ['ask_second', 'setup'],
    ],
  );
});

Deno.test('new agents that call each other are registered in the order the calls need', () => {
  const askThird = asks('ask_third', 'third');
  const { written } = planned(
    { 'setup.ts': INLINE },
    {
      agents: [
        host('desk', ['list']),
        host('second-desk', ['ask_third'], [askThird]),
        host('third', []),
      ],
      profiles: ['second-desk', 'third'],
      tools: [askThird],
    },
  );
  assertEquals(written['setup.ts']?.split('\n').slice(7, 12), [
    `  registerProfile(${DESK});`,
    '  registerProfile(third.profile);',
    '  registerAskThird();',
    '  registerProfile(secondDesk.profile);',
    '}',
  ]);
});

Deno.test('a setup that registers nothing yet takes the lines in its function, or at its end', () => {
  const added = { agents: [host('a', [])], profiles: ['a'], tools: [counts('count')] };
  const lines = (setup: string) => planned({ 'setup.ts': setup }, added).written['setup.ts'];
  const top = "import { registerProfile } from '@theoremjs/agents';";
  const imports = `${top}\nimport { registerCount } from './count';\nimport * as a from './a';`;
  assertEquals(
    lines(`${top}\n\nexport default function register() {}\n`),
    `${imports}\n\nexport default function register() {\n  registerCount();\n  registerProfile(a.profile);\n}\n`,
  );
  assertEquals(
    lines(`${top}\n\nexport default function register() {\n\tstart();\n}\n`),
    `${imports}\n\nexport default function register() {\n\tstart();\n\tregisterCount();\n\tregisterProfile(a.profile);\n}\n`,
  );
  assertEquals(lines(top), `${imports}\nregisterCount();\nregisterProfile(a.profile);\n`);
  // The kernel's name comes in by a namespace here, so the new line brings its own import.
  assertEquals(
    planned(
      {
        'setup.ts': "import './agents.ts';\n",
        'agents.ts': "import { defineProfile } from 'npm:@theoremjs/agents';\n",
      },
      { agents: [host('a', [])], profiles: ['a'], tools: [] },
      'setup.ts',
    ).written,
    {
      'a.ts':
        "import { defineProfile } from 'npm:@theoremjs/agents';\n\nexport const profile = defineProfile({\n  type: 'host',\n  id: 'a',\n  tools: {\n    allow: [],\n  },\n});\n",
      'setup.ts':
        "import './agents.ts';\nimport * as a from './a.ts';\nimport { registerProfile } from 'npm:@theoremjs/agents';\nregisterProfile(a.profile);\n",
    },
  );
});

Deno.test('what has no safe place is named and nothing is planned for it', () => {
  const added = (ids: string[], tools: ToolRegistration[] = []) => ({
    agents: ids.map((id) => host(id, [])),
    profiles: ids,
    tools,
  });
  // No file imports the kernel, so the studio cannot tell how this project registers.
  assertEquals(planned({ 'setup.ts': 'export {};\n' }, added(['a'], [counts('count')])), {
    written: {},
    statuses: [
      ['a', 'setup', 'setup.ts'],
      ['count', 'setup', 'setup.ts'],
    ],
  });
  // A registration in a loop or a branch: a line beside it would not run once.
  const looped = INLINE.replace(
    `  registerProfile(${DESK});`,
    `  for (const p of [${DESK}]) {\n    registerProfile(p);\n  }`,
  );
  assertEquals(planned({ 'setup.ts': looped }, added(['a'])).statuses, [
    ['a', 'setup', 'setup.ts'],
  ]);
  // A file already there, a name that is not a file name, and a name the setup already uses.
  const mixed = planned(
    { 'setup.ts': INLINE, 'second-desk.ts': '// mine\n' },
    added(['a/b', 'second-desk', 'register'], [counts('..'), counts('list')]),
  );
  assertEquals(mixed.statuses, [
    ['..', 'setup', 'setup.ts'],
    ['list', 'written', 'list.ts'],
    ['a/b', 'setup', 'setup.ts'],
    ['second-desk', 'taken', 'second-desk.ts'],
    ['register', 'written', 'register.ts'],
  ]);
  assertEquals(mixed.written['setup.ts']?.split('\n').slice(1, 3), [
    "import { registerList } from './list';",
    "import * as register3 from './register';",
  ]);
  assertEquals(planned({ 'setup.ts': INLINE }, added([])), { written: {}, statuses: [] });
});

/** A decision as the studio compiles it: the profile, and the questions it is asked. */
function decision(id: string): CompiledStudio {
  return {
    agentId: id,
    profile: { type: 'decision', id, models: [{ provider: 'typesafe', model: 'jev' }] },
    customTools: [],
    questions: { urgent: { type: 'noul', instructions: 'Is it urgent?' } },
  };
}

Deno.test('a new decision is a file, and the setup names the questions it is asked', () => {
  const added = (...ids: string[]) => ({ agents: ids.map(decision), profiles: ids, tools: [] });
  const setup = (text: string, ...ids: string[]) => planned({ 'setup.ts': text }, added(...ids));

  // The setup exports no questions yet: the export goes at the end, outside what registers.
  const first = setup(INLINE, 'night-check');
  assertEquals(first.statuses, [['night-check', 'written', 'night-check.ts']]);
  assertEquals(first.written['night-check.ts'].includes('export const questions = {'), true);
  assertEquals(
    first.written['setup.ts'],
    `import { defineProfile, registerProfile, registerTool, z } from '@theoremjs/agents';
import * as nightCheck from './night-check';

export default function register() {
  ${LIST}
  registerProfile(${DESK});
  registerProfile(nightCheck.profile);
}

/** What each decision profile is asked, by profile id. The studio reads it. */
export const questions = {
  'night-check': nightCheck.questions,
};
`,
  );

  // It exports some: each new decision is one more entry, written as the others are.
  const tail = (held: string) =>
    setup(`${INLINE}\nexport const questions = ${held};\n`, 'a', 'b').written['setup.ts'].split(
      'export const questions = ',
    )[1];
  assertEquals(
    tail('{\n  desk: { urgent: URGENT },\n}'),
    '{\n  desk: { urgent: URGENT },\n  a: a.questions,\n  b: b.questions,\n};\n',
  );
  assertEquals(tail('{ desk: ASKED }'), '{ desk: ASKED, a: a.questions, b: b.questions };\n');
  assertEquals(tail('{} satisfies Asked'), '{ a: a.questions, b: b.questions } satisfies Asked;\n');
});

Deno.test('a new decision is not written when the setup cannot name its questions', () => {
  const added = { agents: [decision('a')], profiles: ['a'], tools: [] };
  const refused = { written: {}, statuses: [['a', 'setup', 'setup.ts']] };
  // The questions are made by code, or exported another way: a line there is not the studio's to write.
  assertEquals(
    planned({ 'setup.ts': `${INLINE}\nexport const questions = asked();\n` }, added),
    refused,
  );
  assertEquals(
    planned({ 'setup.ts': `${INLINE}\nconst questions = {};\nexport { questions };\n` }, added),
    refused,
  );
  // Another file registers the profiles: the studio reads the questions from the setup it opens.
  assertEquals(planned(SPLIT, added, 'setup.ts').statuses, [['a', 'written', 'agents/a.ts']]);
  const elsewhere = {
    'setup.ts': "import './register';\n",
    'register.ts': `import { defineProfile, registerProfile } from '@theoremjs/agents';\nregisterProfile(${DESK});\n`,
  };
  assertEquals(planned(elsewhere, added), refused);
});
