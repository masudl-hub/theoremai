import { assertEquals } from '@std/assert';
import { alertLines, alertText, keyLine, loadedText } from '../../studio/server/alerts.ts';
import type { StudioDescription } from '../../studio/server/handler.ts';

const OPEN = {
  project: 'bench',
  workspace: {},
  problems: [],
  asks: { asked: [], destructive: [], inside: [] },
} as unknown as StudioDescription;

Deno.test('a project with nothing to look at prints nothing', () => {
  assertEquals(alertText(OPEN), undefined);
});

Deno.test('each thing the page flags is a line, a long difference named in part', () => {
  const lines = alertLines({
    ...OPEN,
    problems: [
      { profile: 'research.pagereader', message: 'The studio does not know what it asks.' },
    ],
    differences: [{ kind: 'profile', of: 'research.scout', settings: ['a', 'b', 'c', 'd', 'e'] }],
    unregistered: [
      { kind: 'tool', name: 'ask_user', file: 'src/kernel/tools/harness.ts', line: 26 },
    ],
  });
  assertEquals(lines, [
    'research.pagereader: The studio does not know what it asks.',
    'profile research.scout opens differently from what the project registered, in 5 settings: a, b, c and 2 more',
    'tool ask_user is defined at src/kernel/tools/harness.ts:26 but the project did not register it',
  ]);
});

Deno.test('the message heads the lines with how many there are', () => {
  assertEquals(
    alertText({ ...OPEN, peopleProblem: 'existing() threw.' }),
    'theorem studio: 1 thing to look at in bench\n  - people: existing() threw.',
  );
});

const LOADED = {
  ...OPEN,
  setup: 'research.studio.setup.ts',
  workspace: {
    agents: [
      {
        key: 'a',
        identity: { agentId: 'research.scout', profileType: 'text' },
        modelBindings: [{ provider: 'gemini' }, { provider: 'gemini' }],
      },
      {
        key: 'b',
        identity: { agentId: '', profileType: 'decision' },
        modelBindings: [{ provider: 'openrouter' }],
      },
    ],
    toolSpecs: [{ toolType: 'function' }, { toolType: 'http' }, { toolType: 'function' }],
  },
} as unknown as StudioDescription;

Deno.test('the command first says what loaded: the setup, its entry, each agent, the tools, the keys', () => {
  assertEquals(loadedText(LOADED, { entry: 'src/research.ts', keys: 'checking' }).split('\n'), [
    'theorem studio: bench',
    '  setup   research.studio.setup.ts → entry src/research.ts',
    '  agents  research.scout (text, gemini); b (decision, openrouter)',
    '  tools   2 function, 1 http',
    '  keys    checking gemini, openrouter…',
  ]);
  assertEquals(
    loadedText(LOADED, { keys: 'offline' }).split('\n')[4],
    '  keys    not checked (--offline)',
  );
  assertEquals(
    loadedText(LOADED, { keys: ['key for gemini (GEMINI) works', 'key for openrouter is empty'] })
      .split('\n')
      .slice(4),
    ['  keys    key for gemini (GEMINI) works', '          key for openrouter is empty'],
  );
});

Deno.test('each key check is one line, with what the provider said and never more', () => {
  assertEquals(
    [
      keyLine({ provider: 'gemini', slot: 'GEMINI', state: 'accepted', status: 200 }),
      keyLine({
        provider: 'openrouter',
        state: 'refused',
        status: 401,
        said: 'No auth\ncredentials',
      }),
      keyLine({ provider: 'typesafe', state: 'unreachable' }),
      keyLine({ provider: 'gemini', slot: 'GEMINI', state: 'empty' }),
      keyLine({ provider: 'spaced', state: 'empty' }),
      keyLine({ provider: 'gateway', state: 'unchecked' }),
    ],
    [
      'key for gemini (GEMINI) works',
      'key for openrouter refused 401: No auth credentials',
      'key for typesafe could not be checked: no answer',
      'key for gemini (GEMINI) is empty',
      'key for spaced is in no slot: no model or registration names one',
      'key for gateway has no check to ask',
    ],
  );
});
