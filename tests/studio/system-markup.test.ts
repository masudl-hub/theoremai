import { assertEquals } from '@std/assert';
import { parseSystemMarkup } from '../../studio/system-markup.ts';

Deno.test('a prompt with no {private: section is the text alone, private throughout', () => {
  assertEquals(parseSystemMarkup('  Be brief.\n'), { ok: true, lines: ['Be brief.'] });
  assertEquals(parseSystemMarkup(' \n '), { ok: true, lines: [] });
});

Deno.test('a {private: section becomes a private part and the text around it stays as written', () => {
  assertEquals(parseSystemMarkup('Say "hi". {private: Code 7731.} Then help.'), {
    ok: true,
    lines: [['Say "hi". ', { private: 'Code 7731.' }, ' Then help.']],
  });
  assertEquals(parseSystemMarkup('Greet.\n{private:\n  Never discount.\n}\nHelp.\n'), {
    ok: true,
    lines: [['Greet.\n', { private: 'Never discount.' }, '\nHelp.']],
  });
  assertEquals(parseSystemMarkup('{ private : A }{private:B}'), {
    ok: true,
    lines: [[{ private: 'A' }, { private: 'B' }]],
  });
});

Deno.test('braces inside a section pair up, so JSON in a private section stays whole', () => {
  assertEquals(parseSystemMarkup('Reply as JSON. {private: Keys: {"code": {"v": 1}}.} Done.'), {
    ok: true,
    lines: [['Reply as JSON. ', { private: 'Keys: {"code": {"v": 1}}.' }, ' Done.']],
  });
});

Deno.test('braces outside a section are plain text', () => {
  assertEquals(parseSystemMarkup('Reply as {"a": 1}. {private: x} }'), {
    ok: true,
    lines: [['Reply as {"a": 1}. ', { private: 'x' }, ' }']],
  });
});

Deno.test('an unclosed or empty section fails with its line', () => {
  assertEquals(parseSystemMarkup('One.\nTwo {private: secret {x}'), {
    ok: false,
    message: 'The {private: section on line 1 has no closing }.',
  });
  assertEquals(parseSystemMarkup('{private:  }'), {
    ok: false,
    message: 'The {private: section on line 1 is empty.',
  });
});

Deno.test('a blank line starts a new line, except inside a {private: section', () => {
  assertEquals(parseSystemMarkup('Be brief.\n\nwhen plan is paid: Take your time.\n  \n\nBye.\n'), {
    ok: true,
    lines: ['Be brief.', 'when plan is paid: Take your time.', 'Bye.'],
  });
  assertEquals(parseSystemMarkup('One.\nStill one.'), { ok: true, lines: ['One.\nStill one.'] });
  assertEquals(parseSystemMarkup('Say hi. {private: One.\n\nTwo.}\n\n{private: Three.}\n\nDone.'), {
    ok: true,
    lines: [['Say hi. ', { private: 'One.\n\nTwo.' }], [{ private: 'Three.' }], 'Done.'],
  });
});

Deno.test('a section with no closing } is told by the line it opens on', () => {
  assertEquals(parseSystemMarkup('One.\n\nTwo.\n\n{private: Three.'), {
    ok: false,
    message: 'The {private: section on line 3 has no closing }.',
  });
});
