import { assertEquals } from '@std/assert';
import { readProjectSource } from '../../studio/server/project-source.ts';
import { applyEdits } from '../../studio/server/save-plan.ts';
import { planRemoved, type Removed } from '../../studio/server/save-remove.ts';

const ROOT = '/project';

/** Plans a removal from a project held in memory, and returns each file as Save would leave it. */
function planned(files: Record<string, string>, removed: Partial<Removed>, entry = 'setup.ts') {
  const held = new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text]));
  const source = readProjectSource(`${ROOT}/${entry}`, ROOT, (path) => held.get(path));
  const plan = planRemoved(source, { profiles: [], tools: [], ...removed });
  const written: Record<string, string> = {};
  for (const [file, edits] of Map.groupBy(plan.edits, (edit) => edit.file)) {
    written[file.replace(`${ROOT}/`, '')] = applyEdits(held.get(file) ?? '', edits);
  }
  return {
    written,
    gone: plan.gone.map((file) => file.replace(`${ROOT}/`, '')),
    statuses: plan.changes.map(({ of, status }) => [of, status]),
  };
}

const lines = (...text: string[]) => `${text.join('\n')}\n`;

Deno.test('a profile registered where it is defined goes with the comment above it', () => {
  const setup = lines(
    "import { defineProfile, registerProfile } from '@theoremjs/agents';",
    '',
    '// The desk.',
    "registerProfile(defineProfile({ type: 'host', id: 'desk' }));",
    '',
    '// Greets, and nothing else.',
    'registerProfile(',
    "  defineProfile({ type: 'host', id: 'greeter' }),",
    ');',
    '',
    "export const name = 'garden';",
  );
  const plan = planned({ 'setup.ts': setup }, { profiles: ['greeter'] });
  assertEquals(plan.statuses, [['greeter', 'written']]);
  assertEquals(plan.gone, []);
  assertEquals(
    plan.written['setup.ts'],
    lines(
      "import { defineProfile, registerProfile } from '@theoremjs/agents';",
      '',
      '// The desk.',
      "registerProfile(defineProfile({ type: 'host', id: 'desk' }));",
      '',
      "export const name = 'garden';",
    ),
  );
});

Deno.test('a named profile goes with its registration, and stays when other code reads it', () => {
  const setup = (extra: string[]) =>
    lines(
      "import { defineProfile, registerProfile } from '@theoremjs/agents';",
      '',
      "const desk = defineProfile({ type: 'host', id: 'desk' });",
      "const greeter = defineProfile({ type: 'host', id: 'greeter' });",
      '',
      'registerProfile(desk);',
      'registerProfile(greeter);',
      ...extra,
    );
  assertEquals(
    planned({ 'setup.ts': setup([]) }, { profiles: ['greeter'] }).written['setup.ts'],
    lines(
      "import { defineProfile, registerProfile } from '@theoremjs/agents';",
      '',
      "const desk = defineProfile({ type: 'host', id: 'desk' });",
      '',
      'registerProfile(desk);',
    ),
  );
  const read = planned(
    { 'setup.ts': setup(['export const first = greeter;']) },
    { profiles: ['greeter'] },
  );
  assertEquals(
    read.written['setup.ts'],
    lines(
      "import { defineProfile, registerProfile } from '@theoremjs/agents';",
      '',
      "const desk = defineProfile({ type: 'host', id: 'desk' });",
      "const greeter = defineProfile({ type: 'host', id: 'greeter' });",
      '',
      'registerProfile(desk);',
      'export const first = greeter;',
    ),
  );
});

Deno.test('a profile in its own module goes with the module, its reply shape and its questions', () => {
  const setup = lines(
    "import { registerProfile, registerStructured } from '@theoremjs/agents';",
    "import * as triage from './triage.ts';",
    "import * as desk from './desk.ts';",
    '',
    'registerProfile(desk.profile);',
    'registerProfile(triage.profile);',
    'registerStructured(triage.structured.id, triage.structured.spec);',
    '',
    'export const questions = {',
    "  'triage': triage.questions,",
    '  desk: desk.questions,',
    '};',
  );
  const module = (id: string) =>
    lines(
      "import { defineProfile } from '@theoremjs/agents';",
      '',
      `export const profile = defineProfile({ type: 'decision', id: '${id}' });`,
      "export const structured = { id: 'shape', spec: {} };",
      'export const questions = [];',
    );
  const plan = planned(
    { 'setup.ts': setup, 'triage.ts': module('triage'), 'desk.ts': module('desk') },
    { profiles: ['triage'] },
  );
  assertEquals([plan.statuses, plan.gone], [[['triage', 'written']], ['triage.ts']]);
  assertEquals(plan.written, {
    'setup.ts': lines(
      "import { registerProfile, registerStructured } from '@theoremjs/agents';",
      "import * as desk from './desk.ts';",
      '',
      'registerProfile(desk.profile);',
      '',
      'export const questions = {',
      '  desk: desk.questions,',
      '};',
    ),
  });
});

Deno.test('a module that defines two profiles keeps the one that was not removed', () => {
  const setup = lines(
    "import { registerProfile } from '@theoremjs/agents';",
    "import * as both from './both.ts';",
    '',
    'registerProfile(both.first);',
    'registerProfile(both.second);',
  );
  const both = lines(
    "import { defineProfile } from '@theoremjs/agents';",
    '',
    "export const first = defineProfile({ type: 'host', id: 'first' });",
    "export const second = defineProfile({ type: 'host', id: 'second' });",
  );
  const plan = planned({ 'setup.ts': setup, 'both.ts': both }, { profiles: ['second'] });
  assertEquals(plan.gone, []);
  assertEquals(plan.written, {
    'setup.ts': lines(
      "import { registerProfile } from '@theoremjs/agents';",
      "import * as both from './both.ts';",
      '',
      'registerProfile(both.first);',
    ),
    'both.ts': lines(
      "import { defineProfile } from '@theoremjs/agents';",
      '',
      "export const first = defineProfile({ type: 'host', id: 'first' });",
    ),
  });
});

Deno.test('a tool goes where it is registered: in the setup, in a function of its own, in a file of its own', () => {
  const tool = (name: string, indent = '') => [
    `${indent}registerTool({`,
    `${indent}  name: '${name}',`,
    `${indent}  handler: () => ({}),`,
    `${indent}});`,
  ];
  const setup = lines(
    "import { registerTool } from '@theoremjs/agents';",
    "import { registerCount, registerSum } from './count.ts';",
    "import './list.ts';",
    '',
    'export default function register(): void {',
    ...tool('water', '  '),
    '',
    ...tool('prune', '  '),
    '',
    '  registerCount();',
    '  registerSum();',
    '}',
  );
  const count = lines(
    "import { registerTool } from '@theoremjs/agents';",
    '',
    '/** Registers the count. */',
    'export function registerCount(): void {',
    ...tool('count', '  '),
    '}',
    '',
    'export function registerSum(): void {',
    ...tool('sum', '  '),
    '}',
  );
  const list = lines("import { registerTool } from '@theoremjs/agents';", '', ...tool('list'));
  const files = { 'setup.ts': setup, 'count.ts': count, 'list.ts': list };

  const plan = planned(files, { tools: ['prune', 'count', 'list'] });
  assertEquals(
    plan.statuses.map(([, status]) => status),
    ['written', 'written', 'written'],
  );
  assertEquals(plan.gone, ['list.ts']);
  assertEquals(plan.written, {
    'setup.ts': lines(
      "import { registerTool } from '@theoremjs/agents';",
      "import { registerSum } from './count.ts';",
      '',
      'export default function register(): void {',
      ...tool('water', '  '),
      '',
      '  registerSum();',
      '}',
    ),
    'count.ts': lines(
      "import { registerTool } from '@theoremjs/agents';",
      '',
      'export function registerSum(): void {',
      ...tool('sum', '  '),
      '}',
    ),
  });

  const every = planned(files, { tools: ['count', 'sum'] });
  assertEquals(every.gone, ['count.ts']);
  assertEquals(every.written['setup.ts']?.includes('count.ts'), false);
});

Deno.test('what the studio cannot follow is named with its place, and nothing is planned for it', () => {
  const setup = lines(
    "import { defineProfile, registerProfile, registerTool } from '@theoremjs/agents';",
    '',
    "const all = [defineProfile({ type: 'host', id: 'listed' })];",
    'for (const profile of all) registerProfile(profile);',
    "const kept = defineProfile({ type: 'host', id: 'kept' });",
    'export const profiles = [kept];',
    "const made = registerTool({ name: 'held' });",
  );
  const plan = planned(
    { 'setup.ts': setup },
    { profiles: ['listed', 'kept', 'missing'], tools: ['held'] },
  );
  assertEquals(plan.statuses, [
    ['listed', 'removed'],
    ['kept', 'removed'],
    ['missing', 'removed'],
    ['held', 'removed'],
  ]);
  assertEquals([plan.written, plan.gone], [{}, []]);
});

Deno.test('entries on one line leave the commas the list needs', () => {
  const setup = (questions: string) =>
    lines(
      "import { defineProfile, registerProfile } from '@theoremjs/agents';",
      "import { a, b, c } from './asked.ts';",
      '',
      "registerProfile(defineProfile({ type: 'decision', id: 'a' }));",
      "registerProfile(defineProfile({ type: 'decision', id: 'b' }));",
      "registerProfile(defineProfile({ type: 'decision', id: 'c' }));",
      questions,
    );
  const asked = lines('export const a = [];', 'export const b = [];', 'export const c = [];');
  const left = (profiles: string[]) =>
    planned(
      { 'setup.ts': setup('export const questions = { a, b, c };'), 'asked.ts': asked },
      { profiles },
    )
      .written['setup.ts']?.trimEnd()
      .split('\n')
      .at(-1);
  assertEquals(left(['a']), 'export const questions = { b, c };');
  assertEquals(left(['c']), 'export const questions = { a, b };');
  assertEquals(left(['b', 'c']), 'export const questions = { a };');
  assertEquals(left(['a', 'b']), 'export const questions = { c };');
});
