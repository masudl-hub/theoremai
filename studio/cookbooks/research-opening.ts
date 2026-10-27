/**
 * Acceptance for the research cookbook's recorded Goals opener: several successful tools, a
 * staged read, citations, and a prose reply.
 */
import type { TranscriptBlock } from '@theoremjs/agents/interface';
import { DEMO_RESEARCH_STAGE_READ_TOOLS } from './tools.ts';

const DISCOVERY = new Set([
  'list_arxiv',
  'search_web',
  'search_github',
  'search_models',
  'search_datasets',
  'find_library',
  'ask_repo_docs',
]);
const STAGE_READ = new Set(DEMO_RESEARCH_STAGE_READ_TOOLS);
const BEYOND_ARXIV = new Set([
  'search_web',
  'search_github',
  'search_models',
  'search_datasets',
  'find_library',
  'ask_repo_docs',
  ...DEMO_RESEARCH_STAGE_READ_TOOLS,
]);

export type ResearchOpeningRefusal = { ok: false; why: string };
export type ResearchOpeningAccepted = {
  ok: true;
  tools: string[];
  kinds: string[];
  complete: number;
  failed: number;
};

function toolCalls(opening: readonly TranscriptBlock[]) {
  return opening.flatMap((block) => (block.kind === 'tool' ? [block] : []));
}

/** Whether `opening` meets the Goals research example bar. */
export function judgeResearchOpening(
  opening: readonly TranscriptBlock[],
): ResearchOpeningAccepted | ResearchOpeningRefusal {
  const kinds = opening.map((block) => block.kind);
  const calls = toolCalls(opening);
  const unique = [...new Set(calls.map((block) => block.tool.name))];
  const complete = calls.filter((block) => block.tool.state?.phase === 'complete');
  const failed = calls.filter((block) => block.tool.state?.phase === 'error');
  const prose = opening
    .filter((block) => block.kind === 'text')
    .map((block) => (block.kind === 'text' ? block.text : ''))
    .join('\n')
    .trim();
  if (prose.length < 80) {
    return {
      ok: false,
      why: prose ? `prose reply too short (${String(prose.length)} chars)` : 'no prose reply',
    };
  }
  if (unique.length < 3) {
    return {
      ok: false,
      why: `only ${String(unique.length)} distinct tool(s): ${unique.join(', ') || '(none)'}`,
    };
  }
  if (complete.length < 3) {
    return {
      ok: false,
      why: `only ${String(complete.length)} successful tool call(s) (need ≥ 3)`,
    };
  }
  const settled = complete.length + failed.length;
  if (settled > 0 && complete.length / settled < 0.75) {
    return {
      ok: false,
      why: `only ${String(complete.length)}/${String(settled)} tools succeeded (need ≥ 75%)`,
    };
  }
  if (![...unique].some((name) => DISCOVERY.has(name))) {
    return { ok: false, why: 'no discovery tool (arxiv / search / web)' };
  }
  if (![...unique].some((name) => BEYOND_ARXIV.has(name))) {
    return { ok: false, why: 'never left arxiv' };
  }
  if (!complete.some((block) => STAGE_READ.has(block.tool.name))) {
    return { ok: false, why: 'no successful page/card/readme read' };
  }
  if (!opening.some((block) => block.kind === 'citation')) {
    return { ok: false, why: 'no citations in the transcript' };
  }

  return {
    ok: true,
    tools: unique,
    kinds,
    complete: complete.length,
    failed: failed.length,
  };
}
