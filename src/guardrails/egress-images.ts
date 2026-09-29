/**
 * Images in a reply load on the reader's device the moment it renders, so a
 * reply can post data to any server by writing it into an image URL: no tool
 * call, no click. An image is a leak when its URL is not one the model was
 * given this turn and its host is not one the host allowed.
 *
 * The reply is read the way a renderer reads it: markdown images (inline, and
 * reference definitions an image may use) and HTML tags as the browser
 * tokenizes them, with entities, escapes and CSS escapes decoded. Where a
 * renderer could read it more than one way, every reading is checked.
 *
 * @module
 */

import type { TurnHistoryMessage } from '../kernel/turn-events.ts';
import type { ProviderCompleteRequest } from '../kernel/types.ts';
import { textForScan } from './serialize.ts';

/** What decides whether an image URL is a leak. */
interface ImageScope {
  /** Canonical URLs the model was given this turn. Unset: none. */
  seenUrls?: ReadonlySet<string>;
  /** Hostnames images may load from whatever their URL. */
  imageHosts?: readonly string[];
}

interface Embed {
  start: number;
  end: number;
  urls: string[];
}

const RELATIVE_BASE = 'https://relative.invalid/';
const RELATIVE_HOST = 'relative.invalid';

/** RFC 2606 / 6761 names: nobody can receive a request to them. */
const RESERVED_HOST = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid)$/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  sol: '/',
  bsol: '\\',
  period: '.',
  quest: '?',
  equals: '=',
  percnt: '%',
  num: '#',
  commat: '@',
  excl: '!',
  lpar: '(',
  rpar: ')',
  comma: ',',
  semi: ';',
  plus: '+',
  ast: '*',
  midast: '*',
  dollar: '$',
  lowbar: '_',
  UnderBar: '_',
  hyphen: '‐',
  dash: '‐',
  Hat: '^',
  grave: '`',
  verbar: '|',
  vert: '|',
  lsqb: '[',
  lbrack: '[',
  rsqb: ']',
  rbrack: ']',
  lcub: '{',
  lbrace: '{',
  rcub: '}',
  rbrace: '}',
  Tab: '\t',
  NewLine: '\n',
  nbsp: ' ',
};

const ENTITY = /&(?:#[xX]([0-9a-fA-F]{1,6});?|#(\d{1,7});?|([A-Za-z][A-Za-z0-9]{0,31});?)/g;

/** Decoded text, and whether a named entity was left that this table does not know. */
function decodeEntities(text: string): { text: string; unknown: boolean } {
  let unknown = false;
  const decoded = text.replace(ENTITY, (whole, hex, dec, name) => {
    if (hex || dec) {
      const code = Number.parseInt(hex ?? dec, hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    }
    const char = NAMED_ENTITIES[name];
    if (char !== undefined) return char;
    unknown = true;
    return whole;
  });
  return { text: decoded, unknown };
}

const PUNCTUATION_ESCAPE = /\\([!-/:-@[-\x60{-~])/g;

function unescapeMarkdown(text: string): string {
  return text.replace(PUNCTUATION_ESCAPE, '$1');
}

const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9a-fA-F]))/g;

function unescapeCss(text: string): string {
  return text.replace(CSS_ESCAPE, (_, hex, char) =>
    hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff) || 0xfffd) : char,
  );
}

/** The canonical absolute URL `url` loads, or undefined for one relative to the page. */
function canonicalUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, RELATIVE_BASE);
  } catch {
    return undefined;
  }
  if (parsed.hostname === RELATIVE_HOST || !parsed.hostname) return undefined;
  return parsed.href;
}

const URL_IN_TEXT = /(?:https?|wss?|ftp):\/\/[^\s<>\x22\x27\x60\\]+/gi;
const URL_TRAILER = /[.,;:!?)\]}\x27\x22*_~>]+$/;

const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|([\s\S]))/g;
const JSON_CONTROL: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/** `text` with JSON string escapes decoded, as tool results and serialized history carry it. */
function unescapeJson(text: string): string {
  return text.replace(JSON_ESCAPE, (_, hex, char) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : (JSON_CONTROL[char] ?? char),
  );
}

/** Adds every absolute URL in `text`, as a reader of it could have copied it. */
function addSeenUrls(seen: Set<string>, text: string): void {
  const readings = new Set([text, unescapeJson(text), decodeEntities(text).text]);
  for (const reading of readings) {
    for (const [found] of reading.matchAll(URL_IN_TEXT)) {
      let url = found;
      for (;;) {
        const canonical = canonicalUrl(url);
        if (canonical) seen.add(canonical);
        const trimmed = url.replace(URL_TRAILER, (tail) => tail.slice(1));
        if (trimmed === url) break;
        url = trimmed;
      }
    }
  }
}

/** Adds the URLs in history the model is given, less its own earlier replies. */
function addHistoryUrls(seen: Set<string>, messages: readonly TurnHistoryMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'assistant') addSeenUrls(seen, textForScan(message).text);
  }
}

/** Adds the URLs in what `request` gives the model. */
function addRequestUrls(
  seen: Set<string>,
  request: Pick<ProviderCompleteRequest, 'system' | 'input' | 'history' | 'continuation'>,
): void {
  addSeenUrls(seen, request.system);
  addSeenUrls(seen, textForScan(request.input).text);
  addHistoryUrls(seen, request.history ?? []);
  addHistoryUrls(seen, request.continuation ?? []);
}

/** Whether loading `raw` could carry data somewhere the host did not allow. */
function urlLeaks(raw: string, scope: ImageScope): boolean {
  const { text, unknown } = decodeEntities(raw.trim());
  const canonical = canonicalUrl(text);
  if (canonical && scope.seenUrls?.has(canonical)) return false;
  if (unknown) {
    const asWritten = canonicalUrl(raw.trim());
    return !(asWritten && scope.seenUrls?.has(asWritten));
  }
  if (!canonical) return false;
  const host = new URL(canonical).hostname.toLowerCase();
  if (RESERVED_HOST.test(host)) return false;
  return !scope.imageHosts?.some((allowed) => allowed.toLowerCase() === host);
}

// ── Markdown ─────────────────────────────────────────────────────────

/** Where the bracketed text opened at `open` closes, or -1. Code spans and escapes hide brackets. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      i++;
    } else if (char === '`') {
      const run = /^\x60+/.exec(text.slice(i))?.[0] as string;
      const close = text.indexOf(run, i + run.length);
      if (close >= 0 && text[close + run.length] !== '`') i = close + run.length - 1;
      else i += run.length - 1;
    } else if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth === 0) return i;
    } else if (char === '\n' && /^\n[ \t]*(?:\n|$)/.test(text.slice(i))) {
      return -1;
    }
  }
  return -1;
}

/** An inline destination starting at `from`: its raw text and where it ends, or undefined. */
function inlineDestination(text: string, from: number): { raw: string; end: number } | undefined {
  const lead = /^[ \t]*(?:\n[ \t]*)?/.exec(text.slice(from))?.[0] as string;
  const at = from + lead.length;
  if (text[at] === '<') {
    const angled = /^<((?:[^<>\n\\]|\\[^\n])*)>/.exec(text.slice(at));
    if (angled) return { raw: angled[1] as string, end: at + angled[0].length };
  }
  let depth = 0;
  let end = at;
  for (; end < text.length; end++) {
    const char = text[end] as string;
    if (char === '\\' && end + 1 < text.length && !/\s/.test(text[end + 1] as string)) {
      end++;
    } else if (/\s/.test(char)) {
      break;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      if (depth === 0) break;
      depth--;
    }
  }
  return end > at ? { raw: text.slice(at, end), end } : undefined;
}

/**
 * Inline images, nested ones included. The destination is read up to the
 * first space whether or not a title and `)` follow, so a renderer lenient
 * about the rest still loads nothing this did not check.
 */
function markdownImages(text: string): Embed[] {
  const embeds: Embed[] = [];
  for (let i = text.indexOf('!['); i >= 0; i = text.indexOf('![', i + 2)) {
    const close = closingBracket(text, i + 1);
    if (close < 0 || text[close + 1] !== '(') continue;
    const destination = inlineDestination(text, close + 2);
    if (destination === undefined) continue;
    embeds.push({ start: i, end: destination.end, urls: [unescapeMarkdown(destination.raw)] });
  }
  return embeds;
}

const DEFINITION =
  /(?:^|\n)[ ]{0,3}\[((?:[^\]\\]|\\[\s\S]){1,999})\]:[ \t]*(?:\n[ \t]*)?(<(?:[^<>\n\\]|\\[^\n])*>|\S+)/g;

/** Reference definitions. Any image may use one, so each counts as an image. */
function referenceDefinitions(text: string): Embed[] {
  const embeds: Embed[] = [];
  for (const match of text.matchAll(DEFINITION)) {
    const raw = match[2] as string;
    const url = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
    embeds.push({
      start: match.index,
      end: match.index + match[0].length,
      urls: [unescapeMarkdown(url)],
    });
  }
  return embeds;
}

// ── HTML ─────────────────────────────────────────────────────────────

const SPACE = /[\t\n\f\r ]/;

/** Attributes of the start tag at `open`, as the HTML tokenizer reads them; undefined if it never ends. */
function startTag(
  text: string,
  open: number,
): { name: string; attributes: [string, string][]; end: number } | undefined {
  let i = open + 1;
  let name = '';
  while (i < text.length && !SPACE.test(text[i] as string) && text[i] !== '/' && text[i] !== '>') {
    name += text[i++];
  }
  const attributes: [string, string][] = [];
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '>') return { name: name.toLowerCase(), attributes, end: i + 1 };
    if (SPACE.test(char) || char === '/') {
      i++;
      continue;
    }
    let attribute = char;
    i++;
    while (
      i < text.length &&
      !SPACE.test(text[i] as string) &&
      !'/>='.includes(text[i] as string)
    ) {
      attribute += text[i++];
    }
    while (i < text.length && SPACE.test(text[i] as string)) i++;
    let value = '';
    if (text[i] === '=') {
      i++;
      while (i < text.length && SPACE.test(text[i] as string)) i++;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, i + 1);
        if (close < 0) return undefined;
        value = text.slice(i + 1, close);
        i = close + 1;
      } else {
        while (i < text.length && !SPACE.test(text[i] as string) && text[i] !== '>')
          value += text[i++];
      }
    }
    attributes.push([attribute.toLowerCase(), value]);
  }
  return undefined;
}

/** Attributes whose value the browser fetches with no click. `href` counts on every tag but a link. */
const LOADING_ATTRIBUTES = new Set([
  'src',
  'srcset',
  'imagesrcset',
  'lowsrc',
  'dynsrc',
  'poster',
  'data',
  'background',
  'xlink:href',
  'codebase',
  'archive',
  'manifest',
  'icon',
]);

const CSS_URL =
  /url\(\s*(?:\x22([^\x22]*)\x22|\x27([^\x27]*)\x27|([^)]*))\s*\)|\x22([^\x22]*)\x22|\x27([^\x27]*)\x27/gi;

function styleUrls(style: string): string[] {
  const urls: string[] = [];
  for (const match of unescapeCss(style).matchAll(CSS_URL)) {
    const url = match.slice(1).find((group) => group !== undefined);
    if (url !== undefined) urls.push(url.trim());
  }
  return urls;
}

/** Each URL a `srcset`-like value names, every way its commas could split it. */
function listUrls(value: string): string[] {
  const urls: string[] = [];
  for (const token of value.split(/[\t\n\f\r ]+/)) {
    const bare = token.replace(/^,+|,+$/g, '');
    if (bare) urls.push(bare, ...bare.split(',').filter(Boolean));
  }
  return urls;
}

function attributeUrls(tag: string, attribute: string, raw: string): string[] {
  const value = decodeEntities(raw).text;
  if (attribute === 'style') return styleUrls(value);
  if (attribute === 'srcdoc') return htmlTags(value).flatMap(({ urls }) => urls);
  if (attribute === 'content' && tag === 'meta') {
    const refresh = /url\s*=\s*[\x27\x22]?([^\x27\x22]*)/i.exec(value);
    return refresh ? [refresh[1] as string] : [];
  }
  if (attribute === 'href') return tag === 'a' || tag === 'area' ? [] : [raw];
  if (!LOADING_ATTRIBUTES.has(attribute)) return [];
  return attribute.endsWith('srcset') || attribute === 'archive' ? listUrls(raw) : [raw];
}

function htmlTags(text: string): Embed[] {
  const embeds: Embed[] = [];
  for (const match of text.matchAll(/<[A-Za-z]/g)) {
    const tag = startTag(text, match.index);
    if (!tag) continue;
    const urls = tag.attributes.flatMap(([attribute, value]) =>
      attributeUrls(tag.name, attribute, value),
    );
    if (urls.length > 0) embeds.push({ start: match.index, end: tag.end, urls });
  }
  return embeds;
}

// ── Checks ───────────────────────────────────────────────────────────

function leaking(embeds: Embed[], scope: ImageScope): Embed[] {
  return embeds.filter(({ urls }) => urls.some((url) => urlLeaks(url, scope)));
}

/** Every image in `text` whose URL is a leak, as spans. */
function imageLeakSpans(text: string, scope: ImageScope): { start: number; end: number }[] {
  const definitions = /!\[/.test(text) ? leaking(referenceDefinitions(text), scope) : [];
  const embeds = [
    ...leaking(markdownImages(text), scope),
    ...definitions,
    ...leaking(htmlTags(text), scope),
  ];
  return embeds.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start);
}

/**
 * Patterns covering every image a renderer could read, for the streaming hold.
 * Each match is at least as long as the image it holds for: an inline image
 * runs to the end of its paragraph, a tag to the `>` the tokenizer ends it at.
 */
const IMAGE_PATTERNS: readonly RegExp[] = [
  /!\[(?:[^\n]|\n[ \t]*\S)*(?:\n[ \t]*)?\]\([ \t]*(?:\n[ \t]*)?(?:<(?:[^<>\n\\]|\\[^\n])*>|(?:[^\s\\]|\\\S)+)/g,
  DEFINITION,
  /!\[/g,
  /<[A-Za-z][^\t\n\f\r />]*(?:[\t\n\f\r /]|[^\t\n\f\r />][^\t\n\f\r />=]*(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:\x22[^\x22]*\x22|\x27[^\x27]*\x27|[^\t\n\f\r >\x22\x27][^\t\n\f\r >]*)?)?)*>/g,
];

/**
 * Tests whether a settled match of `IMAGE_PATTERNS[index]` leaks, read with
 * the reply so far: a definition leaks once any image could use it, and an
 * image opener once a leaking definition has settled. One tester per reply,
 * which it reads once overall.
 */
function imageMatchTester(
  scope: ImageScope,
): (index: number, match: string, reply: string) => boolean {
  let opener = false;
  let scanned = 0;
  let leakingDefinition = false;
  const openerIn = (reply: string): boolean => {
    opener ||= reply.indexOf('![', Math.max(0, scanned - 1)) !== -1;
    scanned = reply.length;
    return opener;
  };
  return (index, match, reply) => {
    switch (index) {
      case 0:
        return leaking(markdownImages(match), scope).length > 0;
      case 1: {
        const leaks = leaking(referenceDefinitions(match), scope).length > 0;
        leakingDefinition ||= leaks;
        return leaks && openerIn(reply);
      }
      case 2:
        return leakingDefinition;
      default:
        return leaking(htmlTags(match), scope).length > 0;
    }
  };
}

export type { ImageScope };
export {
  addHistoryUrls,
  addRequestUrls,
  addSeenUrls,
  IMAGE_PATTERNS,
  imageLeakSpans,
  imageMatchTester,
};
