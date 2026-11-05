import { assertEquals, assertStringIncludes } from '@std/assert';
import {
  checksOf,
  promptDoc,
  promptDocProblem,
  promptMarkup,
  samePrompt,
  withCheck,
  withoutCheck,
} from '../prompt-doc.ts';
import { parseSystemMarkup } from '../system-markup.ts';

const roundTrip = (text: string) => {
  const parsed = parseSystemMarkup(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return promptMarkup(promptDoc(parsed.lines));
};

for (const text of [
  'Be brief.',
  'Say hello.\n\nSay goodbye.',
  'when plan is free: Mention the trial.',
  'when plan is free and path is web: Mention the trial.',
  '{private: when plan is free: ## FREE PLAN\n\n- The user is free.\n- They have a limit.}',
  '{private: ## HEADING\nSome words.}',
  'Hello {private: secret words} and goodbye.',
  '- One\n- {private: Two}\n- Three',
  '1. First\n2. Second',
  'Call them {name} when you greet them.',
  'Say **this** and *that*.',
]) {
  Deno.test(`the document gives the same lines back: ${JSON.stringify(text).slice(0, 48)}`, () => {
    assertEquals(samePrompt(roundTrip(text), text), true);
    assertEquals(promptDocProblem(text), undefined);
  });
}

Deno.test('an empty prompt opens and gives nothing back', () => {
  assertEquals(roundTrip(''), '');
  assertEquals(promptDocProblem(''), undefined);
  assertEquals(JSON.parse(promptDoc([])).root.children.length, 1);
});

Deno.test('broken markup stays in the code view, with its own reason', () => {
  assertStringIncludes(promptDocProblem('{private: open') ?? '', 'no closing }');
});

Deno.test('a when over two paragraphs writes itself on each', () => {
  assertEquals(
    roundTrip('when plan is free: One.\n\nwhen plan is free: Two.\n\nThree.'),
    'when plan is free: One.\n\nwhen plan is free: Two.\n\nThree.',
  );
});

Deno.test('a private stretch across paragraphs keeps one when', () => {
  const text = '{private: when plan is free: One.\n\nTwo.}';
  assertEquals(roundTrip(text), text);
});

Deno.test('text the document would change stays in the code view', () => {
  assertStringIncludes(promptDocProblem('**bold {private: held} bold**') ?? '', 'stays in code');
});

Deno.test('where a private stretch opens around its when and block mark is the same prompt', () => {
  assertEquals(samePrompt('- {private: Two}', '{private: - Two}'), true);
  assertEquals(
    samePrompt('when plan is free: {private: Hi}', '{private: when plan is free: Hi}'),
    true,
  );
});

Deno.test('the spaces beside a private stretch stay in the prompt', () => {
  const text = "- Never {private: claim} you're looking.\n\nHello {private: there} friend.";
  assertEquals(roundTrip(text), text);
  const marked = (style: string) => ({
    type: 'text',
    version: 1,
    text: '',
    format: 0,
    mode: 'normal',
    style,
    detail: 0,
  });
  const doc = JSON.parse(promptDoc(['One two three']));
  const paragraph = doc.root.children[1];
  paragraph.children = [
    { ...marked('--private: 1;'), text: 'One ' },
    { ...marked(''), text: 'two' },
    { ...marked('--private: 1;'), text: ' three' },
  ];
  assertEquals(promptMarkup(JSON.stringify(doc)), '{private: One} two {private: three}');
});

Deno.test('a word moving out of a private stretch is another prompt', () => {
  assertEquals(samePrompt('{private: one two}', 'one {private: two}'), false);
});

Deno.test('one when holds one value, and picking it again takes it off', () => {
  assertEquals(withCheck(null, 'plan', 'free'), 'plan is free');
  assertEquals(withCheck('plan is free', 'plan', 'paid'), 'plan is paid');
  assertEquals(withCheck('plan is free', 'path', 'web'), 'plan is free and path is web');
  assertEquals(withCheck('plan is free', 'plan', 'free'), null);
});

Deno.test('taking a check off leaves the others', () => {
  assertEquals(checksOf('plan is free and path is web'), ['plan is free', 'path is web']);
  assertEquals(withoutCheck('plan is free and path is web', 'plan is free'), 'path is web');
  assertEquals(withoutCheck('plan is free', 'plan is free'), null);
});
