import '../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import {
  resolveTurnSystem,
  resolveTurnSystemPrompt,
} from '../../src/kernel/registry/system-prompt.ts';
import {
  assertSystemLines,
  systemLinesProblem,
  toolPathProblem,
} from '../../src/kernel/system-lines.ts';
import { boundSystem, systemText } from '../../src/kernel/system-parts.ts';
import type {
  ModelProfile,
  ProfileConditions,
  ProfileIdentity,
  ProfileSystem,
  TurnRequest,
} from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const CONDITIONS: ProfileConditions = {
  path: ['web', 'imessage', 'alexa', 'live-call'],
  plan: ['free', 'paid'],
  group: ['yes', 'no'],
};
const WEB_FREE = { path: 'web', conditions: { plan: 'free', group: 'no' } };
const ALEXA_PAID = { path: 'alexa', conditions: { plan: 'paid', group: 'no' } };
const TONE = { choices: [{ value: 'warm' }, { value: 'cold' }] };
const OTHER = { choices: [{ value: 'o' }] };

function define(identity: ProfileIdentity, slots?: Record<string, typeof TONE>): ModelProfile {
  const defined = defineProfile({
    type: 'text',
    id: 'lines',
    identity,
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true, slots },
  });
  if (defined.type !== 'text') throw new Error('expected a text profile');
  return defined;
}

function profile(
  system: ProfileSystem,
  extra: { slots?: Record<string, typeof TONE>; conditions?: ProfileConditions } = {},
): ModelProfile {
  return define({ handle: 'x', conditions: extra.conditions ?? CONDITIONS, system }, extra.slots);
}

function sent(prompt: ModelProfile, req: Partial<TurnRequest>): string {
  return systemText(resolveTurnSystemPrompt(prompt, { profile: 'lines', input: {}, ...req }));
}

function refused(prompt: ModelProfile, req: Partial<TurnRequest>, reason: RegExp): void {
  const error = assertThrows(() => sent(prompt, req), TheoremError);
  assertEquals(reason.test(error.message), true, error.message);
}

Deno.test('every line that fits is sent, a blank line apart, before the turn system', () => {
  const prompt = profile([
    'base',
    'when path is web: W',
    'when plan is free and group is no: F',
    'when path is not web: NW',
  ]);
  assertEquals(sent(prompt, WEB_FREE), 'base\n\nW\n\nF');
  assertEquals(sent(prompt, ALEXA_PAID), 'base\n\nNW');
  assertEquals(sent(prompt, { ...WEB_FREE, system: 'Date' }), 'base\n\nW\n\nF\n\nDate');
});

Deno.test('a line keeps its paragraphs, and only the space after the colon goes', () => {
  assertEquals(
    sent(profile(['when path is web:\n\n## Head\nfirst: thing\n\nsecond\n']), WEB_FREE),
    '## Head\nfirst: thing\n\nsecond\n',
  );
});

Deno.test('capital When, and when in the middle of a line, are prose', () => {
  assertEquals(
    sent(profile(['When you reply: be short.', 'Say this when path is web: done']), ALEXA_PAID),
    'When you reply: be short.\n\nSay this when path is web: done',
  );
});

Deno.test('a turn must state every condition, with a listed value, and nothing else', () => {
  const prompt = profile(['base']);
  refused(prompt, { path: 'web', conditions: { plan: 'free' } }, /group/);
  refused(prompt, { path: 'web' }, /plan/);
  refused(prompt, { conditions: { plan: 'free', group: 'no' } }, /path/);
  refused(prompt, { path: 'fax', conditions: { plan: 'free', group: 'no' } }, /fax/);
  refused(prompt, { conditions: { path: 'web', plan: 'free', group: 'no' } }, /own path/);
  refused(prompt, { path: 'web', conditions: { plan: 'free', group: 'no', x: '1' } }, /'x'/);
});

Deno.test('a profile with no conditions takes none', () => {
  const prompt = profile('plain', { conditions: {} });
  assertEquals(sent(prompt, { conditions: {} }), 'plain');
  const bare = define({ handle: 'x', system: 'plain' });
  assertEquals(sent(bare, {}), 'plain');
  refused(bare, { conditions: { a: 'b' } }, /no conditions/);
});

Deno.test('nothing fitting sends nothing', () => {
  assertEquals(sent(profile(['when path is web: W']), ALEXA_PAID), '');
});

Deno.test('a when can read a slot, and only a slot fills {name}', () => {
  const prompt = profile(
    [
      'base',
      'when tone is warm: W {tone}',
      'when tone is not warm: C',
      'when path is web: {other} {braces} {"a":1}',
    ],
    { slots: { tone: TONE, other: OTHER } },
  );
  const slots = (tone: string) => ({ input: { slots: { tone } } });
  assertEquals(sent(prompt, { ...ALEXA_PAID, ...slots('warm') }), 'base\n\nW warm');
  assertEquals(sent(prompt, { ...ALEXA_PAID, ...slots('cold') }), 'base\n\nC');
  refused(prompt, ALEXA_PAID, /tone/);
  refused(prompt, { ...WEB_FREE, ...slots('cold') }, /other/);
  assertEquals(
    sent(prompt, { ...WEB_FREE, input: { slots: { tone: 'cold', other: 'o' } } }),
    'base\n\nC\n\no {braces} {"a":1}',
  );
});

Deno.test('a condition fills no text', () => {
  assertEquals(sent(profile(['Plan {plan}.']), WEB_FREE), 'Plan {plan}.');
});

Deno.test('dropping a private line leaves the plain lines shareable', () => {
  const prompt = profile(['share me', [{ private: 'when path is web: secret' }]]);
  const bound = (req: Partial<TurnRequest>) =>
    boundSystem(resolveTurnSystemPrompt(prompt, { profile: 'lines', input: {}, ...req })).private;
  assertEquals(bound(ALEXA_PAID), []);
  assertEquals(bound(WEB_FREE), ['\n\nsecret']);
});

Deno.test('parts of one line stay together, exactly as written', () => {
  assertEquals(
    sent(
      profile([[{ private: 'when path is web: say: ' }, 'hi', { private: ' then stop\n' }]]),
      WEB_FREE,
    ),
    'say: hi then stop\n',
  );
});

Deno.test('a role reads lines the same way', () => {
  const prompt = define({
    handle: 'x',
    conditions: CONDITIONS,
    system: 'default',
    systemByRole: { critic: ['crit', 'when plan is free: F'] },
  });
  assertEquals(sent(prompt, { ...WEB_FREE, input: { role: 'critic' } }), 'crit\n\nF');
});

Deno.test('a prompt line is refused at registration for each broken shape', () => {
  const cases: [ProfileSystem, RegExp][] = [
    [['when path is fax: x'], /never "fax"/],
    [['when pth is web: x'], /not a field/],
    [['when path is web x'], /needs a condition/],
    [['when path is web:x'], /needs a condition/],
    [['+ when path is web: x'], /start with "\+"/],
    [['+ hello'], /start with "\+"/],
    [['when path is null: x'], /is null/],
    [['when you reply, be short.'], /needs a condition/],
    [['when path is web:'], /no wording/],
    [['when output.path is web: x'], /one condition/],
    [['when input.path is web: x'], /one condition/],
    [['when path.length is 3: x'], /one condition/],
  ];
  for (const [prompt, reason] of cases) {
    const problem = systemLinesProblem(prompt, CONDITIONS, {}) ?? '';
    assertEquals(reason.test(problem), true, `${JSON.stringify(prompt)} -> ${problem}`);
    assertThrows(() => profile(prompt), TheoremError);
  }
});

Deno.test('a when reading a name with no conditions declared is refused', () => {
  const problem = systemLinesProblem(['when path is web: x'], undefined, {}) ?? '';
  assertEquals(/not a field/.test(problem), true, problem);
});

Deno.test('a bad condition declaration is refused', () => {
  const cases: [ProfileConditions, RegExp][] = [
    [{ a: ['b c'] }, /can't take/],
    [{ a: ['null'] }, /can't take/],
    [{ a: [] }, /no values/],
    [{ output: ['a'] }, /reserved/],
    [{ input: ['a'] }, /reserved/],
    [{ 'a b': ['c'] }, /plain name/],
  ];
  for (const [conditions, reason] of cases) {
    const problem = systemLinesProblem(['x'], conditions, {}) ?? '';
    assertEquals(reason.test(problem), true, problem);
  }
  const clash = systemLinesProblem(['x'], CONDITIONS, { plan: ['a'] }) ?? '';
  assertEquals(/both a condition and a slot/.test(clash), true, clash);
});

Deno.test('a bare { private } must sit in a line of its own', () => {
  const error = assertThrows(
    () => assertSystemLines(['a', { private: 'b' }], 'system'),
    TheoremError,
  );
  assertEquals(
    error.message,
    'system[1] must be a string or a list of parts; put { private } inside the list',
  );
  assertThrows(() => assertSystemLines([['a', { private: '' }]], 'system'), TheoremError);
  assertThrows(() => assertSystemLines([], 'system'), TheoremError);
  assertThrows(() => assertSystemLines(7, 'system'), TheoremError);
});

Deno.test('a tool path outside the path condition is named, and star or unset pass', () => {
  assertEquals(
    toolPathProblem(CONDITIONS, [
      { name: 'ok', paths: ['web', '*'] },
      { name: 'bad', paths: ['fax'] },
    ]),
    'Tool bad lists path "fax", which is not one of web, imessage, alexa, live-call.',
  );
  assertEquals(
    toolPathProblem(CONDITIONS, [{ name: 'ok', paths: ['*'] }, { name: 'n' }]),
    undefined,
  );
  assertEquals(toolPathProblem(undefined, [{ name: 'bad', paths: ['fax'] }]), undefined);
});

Deno.test('a turn records which lines of the prompt fit it, by number from 1', () => {
  const written = define({
    handle: 'h',
    conditions: CONDITIONS,
    system: ['always', 'when path is alexa: spoken', 'when plan is free: free'],
  });
  const turn = { profile: 'lines', input: {}, ...WEB_FREE };
  assertEquals(resolveTurnSystem(written, turn).lines, [1, 3]);
  assertEquals(systemText(resolveTurnSystem(written, turn).pieces), 'always\n\nfree');
});
