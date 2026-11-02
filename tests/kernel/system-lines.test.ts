import '../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import { assertTurnOptions } from '../../src/kernel/registry/options.ts';
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
  ProfileIdentity,
  ProfileOptions,
  ProfileSystem,
  TurnRequest,
} from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const choices = (...values: string[]) => ({ choices: values.map((value) => ({ value })) });
const OPTIONS: ProfileOptions = {
  path: choices('web', 'imessage', 'alexa', 'live-call'),
  plan: choices('free', 'paid'),
  group: choices('yes', 'no'),
};
const WEB_FREE = { path: 'web', options: { plan: 'free', group: 'no' } };
const ALEXA_PAID = { path: 'alexa', options: { plan: 'paid', group: 'no' } };
const TONE = choices('warm', 'cold');

function define(identity: ProfileIdentity, person?: ProfileOptions): ModelProfile {
  const defined = defineProfile({
    type: 'text',
    id: 'lines',
    identity,
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true, ...(person ? { options: person } : {}) },
  });
  if (defined.type !== 'text') throw new Error('expected a text profile');
  return defined;
}

function profile(
  system: ProfileSystem,
  extra: { person?: ProfileOptions; code?: ProfileOptions } = {},
): ModelProfile {
  return define({ handle: 'x', options: extra.code ?? OPTIONS, system }, extra.person);
}

function sent(prompt: ModelProfile, req: Partial<TurnRequest>): string {
  return systemText(resolveTurnSystemPrompt(prompt, { profile: 'lines', input: {}, ...req }));
}

function refused(prompt: ModelProfile, req: Partial<TurnRequest>, reason: RegExp): void {
  const turn = { profile: 'lines', input: {}, ...req };
  const error = assertThrows(() => assertTurnOptions(prompt, turn), TheoremError);
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

Deno.test('a turn can leave any option unset, and refuses a value the profile does not list', () => {
  const prompt = profile(['base', 'when plan is free: F', 'when plan is not free: N']);
  assertEquals(sent(prompt, {}), 'base\n\nN');
  assertEquals(sent(prompt, { path: 'web' }), 'base\n\nN');
  assertEquals(sent(prompt, { options: { plan: 'free' } }), 'base\n\nF');
  refused(prompt, { path: 'fax' }, /fax/);
  refused(prompt, { options: { plan: 'gold' } }, /gold/);
  refused(prompt, { options: { path: 'web' } }, /own path/);
  refused(prompt, { options: { x: '1' } }, /'x'/);
});

Deno.test('an option comes in only through the door of the object that holds it', () => {
  const prompt = profile(['base'], { person: { tone: TONE } });
  refused(prompt, { options: { tone: 'warm' } }, /identity\.options/);
  refused(prompt, { input: { options: { plan: 'free' } } }, /inputs\.options/);
});

Deno.test('a profile with no options takes none', () => {
  const prompt = profile('plain', { code: {} });
  assertEquals(sent(prompt, { options: {} }), 'plain');
  const bare = define({ handle: 'x', system: 'plain' });
  assertEquals(sent(bare, {}), 'plain');
  refused(bare, { options: { a: 'b' } }, /no option 'a'/);
});

Deno.test('nothing fitting sends nothing', () => {
  assertEquals(sent(profile(['when path is web: W']), ALEXA_PAID), '');
});

Deno.test('a when reads a person-driven option as it reads a code-driven one', () => {
  const prompt = profile(['base', 'when tone is warm: W', 'when tone is not warm: C'], {
    person: { tone: TONE },
  });
  const picked = (tone: string) => ({ input: { options: { tone } } });
  assertEquals(sent(prompt, picked('warm')), 'base\n\nW');
  assertEquals(sent(prompt, picked('cold')), 'base\n\nC');
  assertEquals(sent(prompt, {}), 'base\n\nC');
});

Deno.test('any option prints with {name}, and a name that is no option stays as written', () => {
  const prompt = profile(['Plan {plan}, tone {tone}. {braces} {"a":1}'], {
    person: { tone: TONE },
  });
  const turn = { ...WEB_FREE, input: { options: { tone: 'warm' } } };
  assertEquals(sent(prompt, turn), 'Plan free, tone warm. {braces} {"a":1}');
});

Deno.test('a line that prints an unset option is not sent', () => {
  const prompt = profile(['base', 'Reply in {tone}.', 'Plan {plan}.'], { person: { tone: TONE } });
  assertEquals(sent(prompt, { options: { plan: 'paid' } }), 'base\n\nPlan paid.');
  assertEquals(sent(prompt, {}), 'base');
  assertEquals(sent(profile(['Plan {plan}.']), {}), '');
});

Deno.test('a private part that prints an unset option takes its whole line with it', () => {
  const prompt = profile(['base', [{ private: 'Plan {plan}: ' }, 'shared']]);
  assertEquals(sent(prompt, {}), 'base');
  assertEquals(sent(prompt, WEB_FREE), 'base\n\nPlan free: shared');
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

Deno.test('a prompt line is refused at registration for each broken shape', () => {
  const cases: [ProfileSystem, RegExp][] = [
    [['when path is fax: x'], /never "fax"/],
    [['when pth is web: x'], /not a field/],
    [['when path is web x'], /needs an option/],
    [['when path is web:x'], /needs an option/],
    [['+ when path is web: x'], /start with "\+"/],
    [['+ hello'], /start with "\+"/],
    [['when path is null: x'], /is null/],
    [['when you reply, be short.'], /needs an option/],
    [['when path is web:'], /no wording/],
    [['when output.path is web: x'], /one option/],
    [['when input.path is web: x'], /one option/],
    [['when path.length is 3: x'], /one option/],
  ];
  for (const [prompt, reason] of cases) {
    const problem = systemLinesProblem(prompt, OPTIONS, undefined) ?? '';
    assertEquals(reason.test(problem), true, `${JSON.stringify(prompt)} -> ${problem}`);
    assertThrows(() => profile(prompt), TheoremError);
  }
});

Deno.test('a when reading a name with no options declared is refused', () => {
  const problem = systemLinesProblem(['when path is web: x'], undefined, undefined) ?? '';
  assertEquals(/not a field/.test(problem), true, problem);
});

Deno.test('a bad option declaration is refused', () => {
  const cases: [ProfileOptions, RegExp][] = [
    [{ a: choices('null') }, /can't take/],
    [{ a: choices('') }, /can't take/],
    [{ a: choices() }, /no values/],
    [{ output: choices('a') }, /reserved/],
    [{ input: choices('a') }, /reserved/],
    [{ 'a b': choices('c') }, /plain name/],
  ];
  for (const [options, reason] of cases) {
    const problem = systemLinesProblem(['x'], options, undefined) ?? '';
    assertEquals(reason.test(problem), true, problem);
  }
  const clash = systemLinesProblem(['x'], OPTIONS, { plan: choices('a') }) ?? '';
  assertEquals(/on both/.test(clash), true, clash);
});

Deno.test('a when naming an option on either object starts, and one on neither is refused', () => {
  const when = ['when tone is warm: x'];
  assertEquals(systemLinesProblem(when, undefined, { tone: TONE }), undefined);
  assertEquals(systemLinesProblem(when, { tone: TONE }, undefined), undefined);
  assertEquals(/not a field/.test(systemLinesProblem(when, OPTIONS, undefined) ?? ''), true);
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

Deno.test('a tool path outside the path option is named, and star or unset pass', () => {
  assertEquals(
    toolPathProblem(OPTIONS, [
      { name: 'ok', paths: ['web', '*'] },
      { name: 'bad', paths: ['fax'] },
    ]),
    'Tool bad lists path "fax", which is not one of web, imessage, alexa, live-call.',
  );
  assertEquals(toolPathProblem(OPTIONS, [{ name: 'ok', paths: ['*'] }, { name: 'n' }]), undefined);
  assertEquals(toolPathProblem(undefined, [{ name: 'bad', paths: ['fax'] }]), undefined);
});

Deno.test('a turn records which lines of the prompt fit it, by number from 1', () => {
  const written = define({
    handle: 'h',
    options: OPTIONS,
    system: ['always', 'when path is alexa: spoken', 'when plan is free: free'],
  });
  const turn = { profile: 'lines', input: {}, ...WEB_FREE };
  assertEquals(resolveTurnSystem(written, turn).lines, [1, 3]);
  assertEquals(systemText(resolveTurnSystem(written, turn).pieces), 'always\n\nfree');
});
