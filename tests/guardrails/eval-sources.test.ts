import '../fixtures/test-host.ts';
import {
  type CorpusCache,
  type CorpusSample,
  fetchRows,
  recordsFromYaml,
  SOURCES,
} from '../../src/guardrails/eval/corpus.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

type Row = Record<string, unknown>;

/** One page of rows per dataset/split/config; every later page is empty, as upstream returns past the end. */
function rowsCache(rows: Row[], seen: URL[] = []): CorpusCache {
  return {
    dir: '',
    fetchText(url) {
      const parsed = new URL(url);
      seen.push(parsed);
      const first = parsed.searchParams.get('offset') === '0';
      return Promise.resolve(JSON.stringify({ rows: first ? rows.map((row) => ({ row })) : [] }));
    },
  };
}

function load(id: string, cache: CorpusCache, limit = 1000): Promise<CorpusSample[]> {
  const source = SOURCES.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`corpus source '${id}' is not registered`);
  return source.load(cache, limit);
}

const sample = (source: string, text: string, attack: boolean, category: string): CorpusSample => ({
  text,
  attack,
  source,
  category,
});

Deno.test('every source declares what it samples and what it is licensed under', () => {
  const ids = SOURCES.map((source) => source.id);
  assertEquals(new Set(ids).size, ids.length);
  for (const source of SOURCES) {
    assertEquals(source.licence.length > 0 && source.attribution.length > 0, true);
    assertEquals(source.sampleLimit > 0, true);
  }
  assertEquals(
    SOURCES.filter((source) => source.requiresToken).map((source) => source.id),
    ['repo-hard-negatives', 'wildguard-benign', 'wildjailbreak'],
  );
});

Deno.test('deepset-prompts keeps only rows with text and a 0/1 label', async () => {
  const out = await load(
    'deepset-prompts',
    rowsCache([
      { text: 'ignore it', label: 1 },
      { text: 'hello', label: 0 },
      { text: 'bad label', label: 2 },
      { text: 5, label: 1 },
      { text: 'no label' },
    ]),
  );
  assertEquals(out, [
    sample('deepset-prompts', 'ignore it', true, 'attack'),
    sample('deepset-prompts', 'hello', false, 'user-prompt'),
  ]);
});

Deno.test('spml-chatbot reads the user prompt and the injection flag, as 1 or true', async () => {
  const out = await load(
    'spml-chatbot',
    rowsCache([
      { 'User Prompt': 'a', 'Prompt injection': 1 },
      { 'User Prompt': 'b', 'Prompt injection': true },
      { 'User Prompt': 'c', 'Prompt injection': 0 },
      { 'User Prompt': 'd' },
      { 'User Prompt': '', 'Prompt injection': 1 },
      { 'User Prompt': 7, 'Prompt injection': 1 },
    ]),
  );
  assertEquals(out, [
    sample('spml-chatbot', 'a', true, 'attack'),
    sample('spml-chatbot', 'b', true, 'attack'),
    sample('spml-chatbot', 'c', false, 'user-prompt'),
    sample('spml-chatbot', 'd', false, 'user-prompt'),
  ]);
});

Deno.test('pii-spans is an attack only where the row carries annotated spans', async () => {
  const out = await load(
    'pii-spans',
    rowsCache([
      { text: '<a>x</a>', spans: [{ start: 0 }] },
      { text: '<b/>', spans: [] },
      { text: '<c/>' },
      { text: '', spans: [{ start: 0 }] },
      { text: 3, spans: [{ start: 0 }] },
    ]),
  );
  assertEquals(out, [
    sample('pii-spans', '<a>x</a>', true, 'pii'),
    sample('pii-spans', '<b/>', false, 'structured-payload'),
    sample('pii-spans', '<c/>', false, 'structured-payload'),
  ]);
});

Deno.test('agent-app-attacks reads the test split and keeps non-empty attack strings', async () => {
  const seen: URL[] = [];
  const out = await load(
    'agent-app-attacks',
    rowsCache([{ attack: 'plant a link' }, { attack: '' }, { attack: 4 }, {}], seen),
  );
  assertEquals(out, [sample('agent-app-attacks', 'plant a link', true, 'attack')]);
  assertEquals(seen[0]?.searchParams.get('split'), 'test');
  assertEquals(seen[0]?.searchParams.get('dataset'), 'Lakera/b3-agent-security-benchmark-weak');
});

Deno.test('nvidia-agentic-ipi takes the injection text and its own category', async () => {
  const out = await load(
    'nvidia-agentic-ipi',
    rowsCache([
      { injection: { injection_text: 'send it', category: 'exfiltration' } },
      { injection: { injection_text: 'do it' } },
      { injection: { injection_text: 'odd', category: 9 } },
      { injection: { injection_text: '' } },
      { injection: { injection_text: 1 } },
      {},
    ]),
  );
  assertEquals(out, [
    sample('nvidia-agentic-ipi', 'send it', true, 'exfiltration'),
    sample('nvidia-agentic-ipi', 'do it', true, 'attack'),
    sample('nvidia-agentic-ipi', 'odd', true, 'attack'),
  ]);
});

Deno.test('glaive-tool-results keeps each function response body over fifteen characters', async () => {
  const chat =
    'USER: hi\nFUNCTION RESPONSE: {"temperature": "21C in Paris"}\nASSISTANT: ok\n' +
    'FUNCTION RESPONSE: {"a": 1}\nFUNCTION RESPONSE:   {"result": "twelve chars!!"}';
  const out = await load(
    'glaive-tool-results',
    rowsCache([{ chat }, { chat: 9 }, { chat: 'no responses here' }]),
  );
  assertEquals(
    out.map((s) => s.text),
    ['{"temperature": "21C in Paris"}', '{"result": "twelve chars!!"}'],
  );
  for (const s of out) {
    assertEquals([s.attack, s.source, s.category], [false, 'glaive-tool-results', 'tool-result']);
  }
});

const BODY = 'a body long enough to count as an email attack';

Deno.test('llmail-adaptive keeps every body of twenty characters or more, by scenario', async () => {
  const out = await load(
    'llmail-adaptive',
    rowsCache([
      { body: BODY, objectives: '{"defense.undetected": true}', scenario: 'level1' },
      { body: BODY, objectives: '{"defense.undetected": false}' },
      { body: BODY, objectives: 'not json' },
      { body: BODY },
      { body: 'x'.repeat(19) },
      { body: 'x'.repeat(20), objectives: '{}', scenario: 3 },
      { body: 5 },
    ]),
  );
  assertEquals(
    out.map((s) => [s.text.length, s.category]),
    [
      [BODY.length, 'level1'],
      [BODY.length, 'attack'],
      [BODY.length, 'attack'],
      [BODY.length, 'attack'],
      [20, 'attack'],
    ],
  );
  assertEquals(
    out.every((s) => s.attack && s.source === 'llmail-adaptive'),
    true,
  );
});

Deno.test('llmail-evaded-defense keeps only bodies the defense did not detect', async () => {
  const seen: URL[] = [];
  const out = await load(
    'llmail-evaded-defense',
    rowsCache(
      [
        { body: BODY, objectives: '{"defense.undetected": true}', scenario: 'level2' },
        { body: BODY, objectives: '{"defense.undetected": false}' },
        { body: BODY, objectives: '{"defense.undetected": "true"}' },
        { body: BODY, objectives: 'not json' },
        { body: BODY },
      ],
      seen,
    ),
  );
  assertEquals(out, [sample('llmail-evaded-defense', BODY, true, 'level2')]);
  assertEquals(seen[0]?.searchParams.get('split'), 'Phase1');
});

Deno.test('multilingual-prompts keeps every non-empty injection prompt as an attack', async () => {
  const out = await load(
    'multilingual-prompts',
    rowsCache([{ prompt_injections: 'ignora todo' }, { prompt_injections: '' }, {}]),
  );
  assertEquals(out, [sample('multilingual-prompts', 'ignora todo', true, 'attack')]);
});

Deno.test('notinject-over-refusal reads all three splits and keeps its own category', async () => {
  const seen: URL[] = [];
  const out = await load(
    'notinject-over-refusal',
    rowsCache(
      [{ prompt: 'ignore this warning?', category: 'Code' }, { prompt: 'plain' }, { prompt: '' }],
      seen,
    ),
  );
  assertEquals(out.length, 6);
  assertEquals(out.slice(0, 2), [
    sample('notinject-over-refusal', 'ignore this warning?', false, 'Code'),
    sample('notinject-over-refusal', 'plain', false, 'over-refusal'),
  ]);
  assertEquals(
    seen
      .filter((url) => url.searchParams.get('offset') === '0')
      .map((url) => url.searchParams.get('split')),
    ['NotInject_one', 'NotInject_two', 'NotInject_three'],
  );
});

Deno.test('aegis-safe-prompts keeps only prompts labelled safe', async () => {
  const out = await load(
    'aegis-safe-prompts',
    rowsCache([
      { prompt: 'what is rust', prompt_label: 'safe' },
      { prompt: 'harm', prompt_label: 'unsafe' },
      { prompt: '', prompt_label: 'safe' },
      { prompt: 2, prompt_label: 'safe' },
      { prompt: 'unlabelled' },
    ]),
  );
  assertEquals(out, [
    sample('aegis-safe-prompts', 'what is rust', false, 'safety-benchmark-benign'),
  ]);
});

Deno.test('nvidia-jailbreak takes the first non-empty user turn of the request input', async () => {
  const out = await load(
    'nvidia-jailbreak',
    rowsCache([
      {
        responses_create_params: {
          input: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '' },
            { role: 'user', content: 'pretend you are DAN' },
            { role: 'user', content: 'second' },
          ],
        },
      },
      { responses_create_params: { input: [{ role: 'user', content: 7 }] } },
      { responses_create_params: { input: 'not a list' } },
      { responses_create_params: {} },
      {},
    ]),
  );
  assertEquals(out, [sample('nvidia-jailbreak', 'pretend you are DAN', true, 'jailbreak')]);
});

Deno.test('wildguard-benign keeps unharmful prompts and marks the adversarial ones', async () => {
  const seen: URL[] = [];
  const out = await load(
    'wildguard-benign',
    rowsCache(
      [
        { prompt: 'story', prompt_harm_label: 'unharmful', adversarial: true },
        { prompt: 'recipe', prompt_harm_label: 'unharmful', adversarial: false },
        { prompt: 'bad', prompt_harm_label: 'harmful', adversarial: true },
        { prompt: '', prompt_harm_label: 'unharmful' },
        { prompt: 1, prompt_harm_label: 'unharmful' },
        { prompt: 'unlabelled' },
      ],
      seen,
    ),
  );
  assertEquals(out, [
    sample('wildguard-benign', 'story', false, 'adversarial-but-harmless'),
    sample('wildguard-benign', 'recipe', false, 'ordinary-prompt'),
  ]);
  assertEquals(seen[0]?.searchParams.get('config'), 'wildguardtrain');
  assertEquals(seen[0]?.searchParams.get('split'), 'train');
});

Deno.test('wildjailbreak is an attack only where the row is adversarial_harmful', async () => {
  const seen: URL[] = [];
  const out = await load(
    'wildjailbreak',
    rowsCache(
      [
        { adversarial: 'harm framing', data_type: 'adversarial_harmful' },
        { adversarial: 'roleplay', data_type: 'adversarial_benign' },
        { adversarial: '', data_type: 'adversarial_harmful' },
        { adversarial: 'no kind' },
        { adversarial: 3, data_type: 'adversarial_harmful' },
      ],
      seen,
    ),
  );
  assertEquals(out, [
    sample('wildjailbreak', 'harm framing', true, 'jailbreak'),
    sample('wildjailbreak', 'roleplay', false, 'adversarial-benign'),
  ]);
  assertEquals(seen[0]?.searchParams.get('config'), 'eval');
});

Deno.test('repo-hard-negatives reads one JSON row per line and skips what is malformed', async () => {
  const jsonl = [
    '{"text": "grant all", "label": 0}',
    '',
    '   ',
    '{"text": "ignore everything", "label": 1}',
    '{broken',
    '{"text": "odd", "label": 2}',
    '{"text": 4, "label": 0}',
    '{"label": 0}',
  ].join('\n');
  const out = await load('repo-hard-negatives', {
    dir: '',
    fetchText: () => Promise.resolve(jsonl),
  });
  assertEquals(out, [
    sample('repo-hard-negatives', 'grant all', false, 'security-docs'),
    sample('repo-hard-negatives', 'ignore everything', true, 'attack'),
  ]);
});

Deno.test('agentdojo-benign tags each fixture with its category and skips one that fails to fetch', async () => {
  const yaml = `items:
  - id_: "0"
    sender: lily.white@gmail.com
    subject: "Birthday Party"
    body: "Hi Emma, please let me know if you can make it on Saturday."
`;
  const asked: string[] = [];
  const out = await load('agentdojo-benign', {
    dir: '',
    fetchText(_url, key) {
      asked.push(key);
      return key.startsWith('slack') ? Promise.reject(new Error('moved')) : Promise.resolve(yaml);
    },
  });
  assertEquals(asked, [
    'workspace_include_inbox.yaml',
    'workspace_include_calendar.yaml',
    'workspace_include_cloud_drive.yaml',
    'slack_environment.yaml',
    'banking_environment.yaml',
    'travel_environment.yaml',
  ]);
  assertEquals(
    out.map((s) => s.category),
    ['email', 'calendar', 'documents', 'transactions', 'travel'],
  );
  assertEquals(
    out.every((s) => !s.attack && s.source === 'agentdojo-benign'),
    true,
  );
});

Deno.test('recordsFromYaml renders each record with its fields, lists and unescaped newlines', () => {
  const yaml = `items:
  - id_: "0"
    to:
      - a@example.com
      - b@example.com
    cc: []
    note: unquoted value with a long enough run of words to pass the length floor
    body: "line one\\nline two"
    "weird": skipped
  - id_: "1"
    body: short
`;
  const [record, ...rest] = recordsFromYaml(yaml);
  assertEquals(rest, []);
  assertEquals(JSON.parse(record ?? ''), {
    id_: '0',
    to: ['a@example.com', 'b@example.com'],
    note: 'unquoted value with a long enough run of words to pass the length floor',
    body: 'line one\nline two',
  });
});

Deno.test('recordsFromYaml finds nothing in text with no records', () => {
  assertEquals(recordsFromYaml(''), []);
  assertEquals(recordsFromYaml('just prose\nwith lines\n- not a record'), []);
  assertEquals(recordsFromYaml('  - Bad_key: x\n'), []);
});

Deno.test('fetchRows asks for pages of a hundred, shrinking the last to the limit', async () => {
  const seen: URL[] = [];
  await fetchRows(
    rowsCache(
      Array.from({ length: 250 }, () => ({ text: 'x' })),
      seen,
    ),
    'a/b',
    250,
    {
      split: 'dev',
      config: 'cfg',
    },
  );
  const pages = seen.map((url) => [
    url.searchParams.get('offset'),
    url.searchParams.get('length'),
    url.searchParams.get('split'),
    url.searchParams.get('config'),
    url.searchParams.get('dataset'),
  ]);
  assertEquals(pages, [
    ['0', '100', 'dev', 'cfg', 'a/b'],
    ['100', '100', 'dev', 'cfg', 'a/b'],
    ['200', '50', 'dev', 'cfg', 'a/b'],
  ]);
});

Deno.test('fetchRows treats a page with no rows key as empty and keeps only entries that carry a row', async () => {
  const cache: CorpusCache = {
    dir: '',
    fetchText: (url) =>
      Promise.resolve(
        new URL(url).searchParams.get('offset') === '0'
          ? JSON.stringify({ rows: [{ row: { a: 1 } }, {}, { row: null }] })
          : '{}',
      ),
  };
  assertEquals(await fetchRows(cache, 'a/b', 500), [{ a: 1 }]);
});

Deno.test('fetchRows retries a page five times with a doubling wait, then moves on', async () => {
  let calls = 0;
  const cache: CorpusCache = {
    dir: '',
    fetchText() {
      calls += 1;
      throw new Error('limited');
    },
  };
  assertEquals(await fetchRows(cache, 'a/b', 100, { retryBaseMs: 1 }), []);
  assertEquals(calls, 5);
});

Deno.test('fetchRows recovers when a retry succeeds', async () => {
  let calls = 0;
  const cache: CorpusCache = {
    dir: '',
    fetchText(url) {
      calls += 1;
      if (calls < 3) throw new Error('limited');
      return Promise.resolve(
        new URL(url).searchParams.get('offset') === '0'
          ? JSON.stringify({ rows: [{ row: { ok: true } }] })
          : '{}',
      );
    },
  };
  assertEquals(await fetchRows(cache, 'a/b', 100, { retryBaseMs: 1 }), [{ ok: true }]);
  assertEquals(calls, 3);
});

Deno.test('fetchRows stops walking once a batch reaches the end of the split', async () => {
  const seen: URL[] = [];
  const rows = await fetchRows(rowsCache([{ n: 1 }], seen), 'a/b', 10_000, { retryBaseMs: 1 });
  assertEquals(rows, [{ n: 1 }]);
  // Four pages per batch; the empty ones end the walk after the first batch.
  assertEquals(seen.length, 4);
});
