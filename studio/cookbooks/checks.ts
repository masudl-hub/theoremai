/**
 * Portable item validators (`outputs.validation.items.*.check`) for cookbook profiles.
 * Because functions cannot cross JSON in `StudioRunPayload`, `runtimeProfileDefinition`
 * attaches the matching check by `profile.id` and list name when running a draft.
 *
 * @module
 */

import type { ItemCheckTurn, ProfileItemCheck } from '@theoremjs/agents';

/** Text as it is compared: markup, typographic marks, case and spacing do not make different words. */
function comparable(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\\n/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>\\]/g, '')
    .replace(/[‘’“”"]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function quotedWords(quote: string): string {
  return comparable(quote)
    .replace(/^'+|'+$/g, '')
    .replace(/[.,;:!?]+$/, '')
    .trim();
}

/** How a source is named in a tool's output: an arXiv id, a Hub or GitHub owner/name, else the URL. */
function sourceKey(uri: string): string {
  const arxiv = /(\d{4}\.\d{4,5})/.exec(uri);
  if (arxiv?.[1] && /arxiv/i.test(uri)) return arxiv[1];
  const repo = /(?:huggingface\.co\/(?:datasets\/)?|github\.com\/)([\w.-]+\/[\w.-]+)/.exec(uri);
  if (repo?.[1]) return repo[1].toLowerCase();
  return uri
    .replace(/[#?].*$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

/** Each quotable tool result's text. DeepWiki's generated wiki (`ask_repo_docs`) is a lead, not a primary source. */
function resultsRead(results: ItemCheckTurn['toolResults']): string[] {
  return results
    .filter(({ tool }) => tool !== 'ask_repo_docs')
    .map(({ output }) => comparable(typeof output === 'string' ? output : JSON.stringify(output)));
}

const refused = (error: string) => ({ isValid: false, error });

/**
 * Verifies each candidate in `research.scout`'s `research.reply`: a candidate with `basis === 'page'`
 * must cite a URL a tool returned this turn and quote exact words from that tool result.
 */
function checkResearchCandidate(item: unknown, turn: ItemCheckTurn) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return refused('Candidate must be an object.');
  }
  const candidate = item as {
    basis?: unknown;
    url?: unknown;
    evidence?: unknown;
  };
  const basis = typeof candidate.basis === 'string' ? candidate.basis : '';
  const url = typeof candidate.url === 'string' ? candidate.url : '';
  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
  if (basis === 'page' && evidence.length === 0) {
    return refused('A candidate based on a page needs that page and the exact words.');
  }
  const read = resultsRead(turn.toolResults);
  if (basis === 'page' && url && !read.some((text) => text.includes(sourceKey(url)))) {
    return refused(
      'No tool returned this URL this turn. Find it with a tool, or set basis memory.',
    );
  }
  for (const entry of evidence) {
    if (!entry || typeof entry !== 'object') continue;
    const { uri = '', quote = '' } = entry as { uri?: string; quote?: string };
    const words = quotedWords(typeof quote === 'string' ? quote : '');
    if (!words) return refused('Each piece of evidence needs the exact words.');
    const key = sourceKey(typeof uri === 'string' ? uri : '');
    const fromIt = read.filter((text) => text.includes(key));
    if (fromIt.length === 0) {
      return refused(
        `No tool returned ${String(uri)} this turn. Cite a source you read, or read it first.`,
      );
    }
    if (!fromIt.some((text) => text.includes(words))) {
      return refused(
        `These words are not in what the tools returned for ${String(uri)}. Quote them exactly.`,
      );
    }
  }
  return { isValid: true };
}

const PASS_ITEM: ProfileItemCheck = () => ({ isValid: true });

const COOKBOOK_ITEM_CHECKS: Readonly<Record<string, Readonly<Record<string, ProfileItemCheck>>>> = {
  'research.scout': {
    candidates: checkResearchCandidate,
  },
};

/** Resolves an item check function for a draft's list rule: the cookbook's check when known, else a pass-through. */
export function resolveDraftItemCheck(profileId: string, list: string): ProfileItemCheck {
  return COOKBOOK_ITEM_CHECKS[profileId]?.[list] ?? PASS_ITEM;
}
