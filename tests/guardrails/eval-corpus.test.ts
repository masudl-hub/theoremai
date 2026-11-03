import '../fixtures/test-host.ts';
import {
  type CorpusCache,
  createCorpusCache,
  fetchRows,
  parseLabelledCsv,
  recordsFromYaml,
  SOURCES,
} from '../../src/guardrails/eval/corpus.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

Deno.test('a cached corpus is served from disk without a second fetch', async () => {
  const dir = await Deno.makeTempDir();
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => {
    fetches += 1;
    return Promise.resolve(new Response(`body ${fetches}`));
  };
  try {
    const cache = createCorpusCache(dir);
    const first = await cache.fetchText('https://example.com/a.csv', 'a.csv');
    const second = await cache.fetchText('https://example.com/a.csv', 'a.csv');
    assertEquals([first, second, fetches], ['body 1', 'body 1', 1]);
  } finally {
    globalThis.fetch = realFetch;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a failing page waits twice as long before each retry', async () => {
  const delays: (number | undefined)[] = [];
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((run: () => void, ms?: number) => {
    delays.push(ms);
    return realTimeout(run, 0);
  }) as typeof setTimeout;
  const cache: CorpusCache = {
    dir: '',
    fetchText: () => Promise.reject(new Error('limited')),
  };
  try {
    assertEquals(await fetchRows(cache, 'a/b', 100, { retryBaseMs: 10 }), []);
  } finally {
    globalThis.setTimeout = realTimeout;
  }
  assertEquals(delays, [10, 20, 40, 80, 160]);
});

Deno.test('parseLabelledCsv drops a blank label, a missing label, and an empty text', () => {
  const csv = 'text,label\nspaces, \nno comma here\n,1\nkept,0\n';
  assertEquals(parseLabelledCsv(csv), [{ text: 'kept', label: 0 }]);
});

Deno.test('parseLabelledCsv takes the first line as a header, even with a usable label', () => {
  assertEquals(parseLabelledCsv('title,1\nrow,0\n'), [{ text: 'row', label: 0 }]);
});

Deno.test('parseLabelledCsv removes carriage returns outside quotes', () => {
  assertEquals(parseLabelledCsv('text,label\r\na\rb,1\r\n'), [{ text: 'ab', label: 1 }]);
});

Deno.test('prompt-injection-prompts labels its attacks and sets its benign rows apart', async () => {
  const source = SOURCES.find((candidate) => candidate.id === 'prompt-injection-prompts');
  const cache: CorpusCache = {
    dir: '',
    fetchText: () => Promise.resolve('text,label\nbad,1\nfine,0\n'),
  };
  assertEquals(await source?.load(cache, 10), [
    { text: 'bad', attack: true, source: 'prompt-injection-prompts', category: 'attack' },
    { text: 'fine', attack: false, source: 'prompt-injection-prompts', category: 'user-prompt' },
  ]);
});

const LONG = 'x'.repeat(90);

/** The fields of the one record that `lines` add to, past the length floor by `LONG`. */
function record(lines: string): unknown {
  const records = recordsFromYaml(`items:\n  - id_: "0"\n    note: ${LONG}\n${lines}`);
  assertEquals(records.length, 1);
  return JSON.parse(records[0] ?? '');
}

Deno.test('a YAML key may start with either end of the alphabet', () => {
  assertEquals(record('    amount: 5\n    zip: 9\n'), {
    id_: '0',
    note: LONG,
    amount: '5',
    zip: '9',
  });
});

Deno.test('recordsFromYaml reads tabs as indent and as the space after a key', () => {
  assertEquals(JSON.parse(recordsFromYaml(`\t- id_: "0"\n\tnote:\t${LONG}\n`)[0] ?? ''), {
    id_: '0',
    note: LONG,
  });
});

Deno.test('recordsFromYaml drops the spaces after a value', () => {
  assertEquals(JSON.parse(recordsFromYaml(`  - id_: "0"\n    note: ${LONG}   \n`)[0] ?? ''), {
    id_: '0',
    note: LONG,
  });
});

Deno.test('recordsFromYaml unquotes a value only when a quote closes it', () => {
  assertEquals(record('    half: "open\n    tail: close"\n    empty: ""\n    lone: "\n'), {
    id_: '0',
    note: LONG,
    half: '"open',
    tail: 'close"',
    empty: '',
    lone: '"',
  });
});

Deno.test('a YAML list keeps single words and drops empty or spaced items', () => {
  assertEquals(record('    to:\n      - a@example.com\n      - two words\n      - \n'), {
    id_: '0',
    note: LONG,
    to: ['a@example.com'],
  });
});

Deno.test('a YAML list item with no list open is dropped', () => {
  assertEquals(record('      - stray\n'), { id_: '0', note: LONG });
});

Deno.test('a line with no key is not a field', () => {
  assertEquals(record('    plain words here\n    a b: c\n'), { id_: '0', note: LONG });
});

Deno.test('only a dash, a space, and a key open a new YAML record', () => {
  assertEquals(record('  - : later\n    -xy: z\n    a b: c\n    name: first\n'), {
    id_: '0',
    note: LONG,
    name: 'first',
  });
});

Deno.test('YAML with no list of records yields nothing, however long its fields', () => {
  assertEquals(recordsFromYaml(`note: ${LONG}\ntitle: ${LONG}\n`), []);
});

Deno.test('a YAML record needs more than eighty rendered characters', () => {
  const yaml = (length: number) => `  - id_: "0"\n    note: ${'x'.repeat(length)}\n`;
  assertEquals(JSON.stringify({ id_: '0', note: 'x'.repeat(50) }, null, 2).length, 80);
  assertEquals(recordsFromYaml(yaml(50)), []);
  assertEquals(recordsFromYaml(yaml(51)).length, 1);
});

function glaive(chat: string): Promise<string[]> {
  const source = SOURCES.find((candidate) => candidate.id === 'glaive-tool-results');
  const cache: CorpusCache = {
    dir: '',
    fetchText: (url) =>
      Promise.resolve(
        JSON.stringify({
          rows: new URL(url).searchParams.get('offset') === '0' ? [{ row: { chat } }] : [],
        }),
      ),
  };
  return (source?.load(cache, 100) ?? Promise.resolve([])).then((rows) =>
    rows.map((row) => row.text),
  );
}

Deno.test('a function response may span lines, end in spaces, or follow the colon directly', async () => {
  const multiline = '{\n  "result": "fine and long"\n}';
  const chat =
    `FUNCTION RESPONSE: ${multiline}\nASSISTANT: ok\n` +
    'FUNCTION RESPONSE:{"answer": "no space first"}   \nASSISTANT: ok\n';
  assertEquals(await glaive(chat), [multiline, '{"answer": "no space first"}']);
});

Deno.test('a function response needs more than fifteen characters', async () => {
  const body = (length: number) => `{"a":"${'x'.repeat(length - 8)}"}`;
  assertEquals(await glaive(`FUNCTION RESPONSE: ${body(15)}\n`), []);
  assertEquals(await glaive(`FUNCTION RESPONSE: ${body(16)}\n`), [body(16)]);
});
