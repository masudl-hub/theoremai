import type { TranscriptBlock } from '@theoremjs/agents/interface';
import type { Source } from '@theoremjs/agents/kernel';

/** One source as a citation: its title, and when it's on the web, its link and favicon. */
export type SourceCitation = {
  key: string;
  title: string;
  href?: string;
  icon?: string;
};

export type SourceCitationBlock = Extract<TranscriptBlock, { kind: 'citation' }>;

/**
 * Gemini grounding links through this host rather than to the page, and names
 * the page's own site in the source title instead.
 */
const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';

/** A citation's sources, in the order they were cited. */
export function citationsFromBlock(block: SourceCitationBlock): SourceCitation[] {
  return block.sources.map((source, i) => citationFromSource(source, `c-${String(i)}`));
}

function citationFromSource(source: Source, key: string): SourceCitation {
  const url = webUrl(source.uri);
  const site = url && siteOf(url, source.title);
  return {
    key,
    title: source.title.trim() || hostLabel(source.uri) || source.type,
    ...(url ? { href: url.href } : {}),
    ...(site ? { icon: faviconUrl(site) } : {}),
  };
}

/**
 * A source is linked only at an http(s) URL. Sources come from the model and
 * from tool output, so a `javascript:`, `data:` or other scheme never becomes
 * a clickable link.
 */
function webUrl(uri: string): URL | undefined {
  if (!URL.canParse(uri)) return undefined;
  const url = new URL(uri);
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
}

/** The site a source is on: the link's host, or for a grounding redirect, the site its title names. */
function siteOf(url: URL, title: string): string | undefined {
  if (url.hostname !== GROUNDING_REDIRECT_HOST) return url.hostname;
  const named = title.trim().toLowerCase();
  if (!named.includes('.') || !URL.canParse(`https://${named}`)) return undefined;
  return new URL(`https://${named}`).hostname === named ? named : undefined;
}

/** Google's favicon service; the visitor's browser sends it the site's host, never the page. */
function faviconUrl(site: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=32`;
}

function hostLabel(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return truncate(uri, 40);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
