import { assertEquals } from '@std/assert';
import { parseMarkdownAst } from '../../react/node_modules/@astryxdesign/core/dist/Markdown/parser.js';
import { detectedCodeLanguage, labelUntaggedCode } from '../../react/src/ui/code-language.ts';

const langs = (source: string, isFinal = true) =>
  labelUntaggedCode(parseMarkdownAst(source), isFinal).children.flatMap((node) =>
    node.type === 'code' ? [node.lang] : [],
  );

const PY =
  'import os\n\ndef main():\n    for i in range(10):\n        print(i)\n\nif __name__ == "__main__":\n    main()';
const CSS =
  '.card {\n  color: red;\n  margin: 0 auto;\n}\n@media (max-width: 600px) { .card { display: none; } }';
const fence = (code: string, tag = '') => `\`\`\`${tag}\n${code}\n\`\`\`\n`;

Deno.test('untagged code the detector knows is labelled', () => {
  assertEquals(langs(fence(PY)), ['py']);
  assertEquals(langs(fence(CSS)), ['css']);
});

Deno.test('a fence with a language is left as written', () => {
  assertEquals(langs(fence(CSS, 'python')), ['python']);
});

Deno.test('prose and unsure code stay untagged', () => {
  assertEquals(
    detectedCodeLanguage('Thanks for asking! Here is what I think about it.'),
    undefined,
  );
  assertEquals(langs('```\nsome words in a fence\n```\n'), [null]);
});

Deno.test('a fence inside a quote is labelled too', () => {
  const quoted = fence(CSS)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const doc = labelUntaggedCode(parseMarkdownAst(quoted), true);
  assertEquals(JSON.stringify(doc).includes('"lang":"css"'), true);
});

Deno.test('while streaming the last block is left alone', () => {
  const source = `${fence(CSS)}\ntext\n\n\`\`\`\n${PY}\n`;
  assertEquals(langs(source, false), ['css', null]);
  assertEquals(langs(source, true), ['css', 'py']);
});

Deno.test('a document with nothing to label comes back as it was', () => {
  const doc = parseMarkdownAst('just a paragraph\n');
  assertEquals(labelUntaggedCode(doc, true) === doc, true);
});
