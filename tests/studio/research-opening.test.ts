import { assertEquals } from '@std/assert';
import type { TranscriptBlock } from '@theoremjs/agents/interface';
import { judgeResearchOpening } from '../../studio/cookbooks/research-opening.ts';

function tool(name: string, phase: 'complete' | 'error', callId: string): TranscriptBlock {
  const base = {
    name,
    callId,
    stepId: 's1',
    arguments: {} as Record<string, unknown>,
    startedAt: 1,
    endedAt: 2,
    artifacts: [] as [],
  };
  if (phase === 'complete') {
    return {
      id: callId,
      kind: 'tool',
      tool: {
        ...base,
        state: {
          name,
          callId,
          at: 1,
          phase: 'complete',
          output: { ok: true },
          readBack: '{}',
        },
      },
    };
  }
  return {
    id: callId,
    kind: 'tool',
    tool: {
      ...base,
      state: {
        name,
        callId,
        at: 1,
        phase: 'error',
        failure: { code: 'failed', kind: 'internal', message: 'x' },
        readBack: 'x',
      },
    },
  };
}

Deno.test('judgeResearchOpening accepts a healthy multi-tool prose briefing', () => {
  const opening: TranscriptBlock[] = [
    { id: 'u', kind: 'user-text', text: 'Find memory work.' },
    tool('list_arxiv', 'complete', 'a'),
    tool('search_github', 'complete', 'b'),
    tool('search_models', 'complete', 'c'),
    tool('read_readme', 'complete', 'd'),
    {
      id: 't',
      kind: 'text',
      text: `${'x'.repeat(80)} Briefing with findings.`,
    },
    {
      id: 'c',
      kind: 'citation',
      sources: [{ title: 'a', uri: 'https://example.com/a', type: 'web' }],
    },
    { id: 'd', kind: 'turn-done' },
  ];
  const verdict = judgeResearchOpening(opening);
  assertEquals(verdict.ok, true);
});

Deno.test('judgeResearchOpening refuses when failures are too common', () => {
  const opening: TranscriptBlock[] = [
    { id: 'u', kind: 'user-text', text: 'Find memory work.' },
    tool('list_arxiv', 'complete', 'a'),
    tool('search_github', 'complete', 'b'),
    tool('search_models', 'complete', 'c'),
    tool('search_web', 'error', 'd'),
    tool('search_datasets', 'error', 'e'),
    tool('read_readme', 'complete', 'f'),
    {
      id: 't',
      kind: 'text',
      text: `${'x'.repeat(80)} Briefing with findings.`,
    },
    {
      id: 'c',
      kind: 'citation',
      sources: [{ title: 'a', uri: 'https://example.com/a', type: 'web' }],
    },
    { id: 'd', kind: 'turn-done' },
  ];
  const verdict = judgeResearchOpening(opening);
  assertEquals(verdict.ok, false);
  if (!verdict.ok) assertEquals(verdict.why.includes('75%'), true);
});
