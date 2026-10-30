import { assertEquals } from '@std/assert';
import { resolveDraftItemCheck } from '../../studio/cookbooks/checks.ts';

const check = resolveDraftItemCheck('research.scout', 'candidates');
const PAPER = 'https://arxiv.org/abs/2401.01234v2';
const turn = {
  toolResults: [
    {
      tool: 'search_papers',
      output: { id: '2401.01234', abstract: 'We **measure** “exact” recall.' },
    },
    { tool: 'read_page', output: 'From https://example.com/page/: The set holds 500 rows.' },
    { tool: 'ask_repo_docs', output: 'https://github.com/acme/wiki says it is great.' },
  ],
};
const LATEX_TURN = {
  toolResults: [
    {
      tool: 'list_arxiv',
      output: { id: '2401.01234', abstract: 'This \\emph{training-free} tool.' },
    },
  ],
};
const refusal = async (item: unknown) => ((await check(item, turn)) as { error?: string }).error;

Deno.test('a research candidate passes when it quotes, however marked up, what a tool returned for its source', async () => {
  assertEquals(
    await check(
      {
        basis: 'page',
        url: PAPER,
        evidence: [{ uri: PAPER, quote: '"We measure \'exact\' recall."' }],
      },
      turn,
    ),
    { isValid: true },
  );
  assertEquals(
    await check(
      {
        basis: 'page',
        url: 'https://example.com/page?ref=1',
        evidence: [null, { uri: 'https://example.com/page', quote: 'the set holds 500 rows' }],
      },
      turn,
    ),
    { isValid: true },
  );
  assertEquals(await check({ basis: 'memory' }, turn), { isValid: true });
});

Deno.test('a research candidate is refused for each thing it cannot show', async () => {
  assertEquals(await refusal(['page']), 'Candidate must be an object.');
  assertEquals(await refusal(null), 'Candidate must be an object.');
  assertEquals(
    await refusal({ basis: 'page', url: PAPER }),
    'A candidate based on a page needs that page and the exact words.',
  );
  assertEquals(
    await refusal({
      basis: 'page',
      url: 'https://other.org/x',
      evidence: [{ uri: PAPER, quote: 'recall' }],
    }),
    'No tool returned this URL this turn. Find it with a tool, or set basis memory.',
  );
  assertEquals(
    await refusal({ basis: 'page', url: PAPER, evidence: [{ uri: PAPER, quote: ' "" ' }] }),
    'Each piece of evidence needs the exact words.',
  );
  assertEquals(
    await refusal({
      basis: 'memory',
      evidence: [{ uri: 'https://github.com/acme/wiki', quote: 'it is great' }],
    }),
    'No tool returned https://github.com/acme/wiki this turn. Cite a source you read, or read it first.',
  );
  assertEquals(
    await refusal({
      basis: 'page',
      url: PAPER,
      evidence: [{ uri: PAPER, quote: 'We measure precision.' }],
    }),
    `These words are not in what the tools returned for ${PAPER}. Quote them exactly.`,
  );
});

Deno.test('a list with no cookbook check passes every item', async () => {
  assertEquals(await resolveDraftItemCheck('research.scout', 'other')('anything', turn), {
    isValid: true,
  });
});

Deno.test('a research candidate may quote a LaTeX abstract without its commands', async () => {
  assertEquals(
    await check(
      { basis: 'page', url: PAPER, evidence: [{ uri: PAPER, quote: 'This training-free tool.' }] },
      LATEX_TURN,
    ),
    { isValid: true },
  );
});
