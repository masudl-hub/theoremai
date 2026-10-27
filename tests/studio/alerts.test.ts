import { assertEquals } from '@std/assert';
import { alertLines, alertText } from '../../studio/server/alerts.ts';
import type { StudioDescription } from '../../studio/server/handler.ts';

const OPEN = {
  project: 'bench',
  workspace: {},
  problems: [],
  asks: { asked: [], inside: [] },
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
