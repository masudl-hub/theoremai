import { assertEquals } from '@std/assert';
import { parseSystemMarkup } from '../../studio/system-markup.ts';

Deno.test('a prompt with no {private: section is the text alone, private throughout', () => {
  assertEquals(parseSystemMarkup('  Be brief.\n'), { ok: true, prompt: 'Be brief.' });
  assertEquals(parseSystemMarkup(' \n '), { ok: true, prompt: undefined });
});

Deno.test('a {private: section becomes a private part and the text around it stays as written', () => {
  assertEquals(parseSystemMarkup('Say "hi". {private: Code 7731.} Then help.'), {
    ok: true,
    prompt: ['Say "hi". ', { private: 'Code 7731.' }, ' Then help.'],
  });
  assertEquals(parseSystemMarkup('Greet.\n{private:\n  Never discount.\n}\nHelp.\n'), {
    ok: true,
    prompt: ['Greet.\n', { private: 'Never discount.' }, '\nHelp.'],
  });
  assertEquals(parseSystemMarkup('{ private : A }{private:B}'), {
    ok: true,
    prompt: [{ private: 'A' }, { private: 'B' }],
  });
});

Deno.test('braces inside a section pair up, so JSON in a private section stays whole', () => {
  assertEquals(parseSystemMarkup('Reply as JSON. {private: Keys: {"code": {"v": 1}}.} Done.'), {
    ok: true,
    prompt: ['Reply as JSON. ', { private: 'Keys: {"code": {"v": 1}}.' }, ' Done.'],
  });
});

Deno.test('braces outside a section are plain text', () => {
  assertEquals(parseSystemMarkup('Reply as {"a": 1}. {private: x} }'), {
    ok: true,
    prompt: ['Reply as {"a": 1}. ', { private: 'x' }, ' }'],
  });
});

Deno.test('an unclosed or empty section fails with its line', () => {
  assertEquals(parseSystemMarkup('One.\nTwo {private: secret {x}'), {
    ok: false,
    message: 'The {private: section on line 2 has no closing }.',
  });
  assertEquals(parseSystemMarkup('{private:  }'), {
    ok: false,
    message: 'The {private: section on line 1 is empty.',
  });
});
