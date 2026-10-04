/**
 * Images in a reply load on the reader's device the moment it renders, so a
 * reply can post data to any server by writing it into an image URL: no tool
 * call, no click. Links do the same wherever the host unfurls them into a
 * preview, and on a click everywhere else. An image or link is a leak when its
 * URL is not one the model was given this turn and its host is not one the
 * host allowed.
 *
 * The reply is read the way a renderer reads it: markdown images and links
 * (inline, and the reference definitions either may use), autolinks, HTML tags
 * as the browser tokenizes them, and `<style>` blocks, with entities, escapes
 * and CSS escapes decoded. Where a renderer could read it more than one way,
 * every reading is checked.
 *
 * @module
 */

import type { TurnHistoryMessage } from '../kernel/turn-events.ts';
import type { ProviderCompleteRequest } from '../kernel/types.ts';
import { textForScan } from './serialize.ts';

/** The URLs a request already contains, split by who controls them: those from the system prompt, user and host history, and those from tool results. */
interface GivenUrls {
  /** From the system prompt, the user and host history. */
  request: ReadonlySet<string>;
  /** From tool results, which whoever wrote them controls. */
  tools: ReadonlySet<string>;
}

interface GivenUrlSets extends GivenUrls {
  request: Set<string>;
  tools: Set<string>;
}

function givenUrlSets(): GivenUrlSets {
  return { request: new Set(), tools: new Set() };
}

interface UrlScope {
  given?: GivenUrls;
  /** Hostnames the check lets through whatever their URL. */
  hosts?: readonly string[];
  /**
   * Whether a URL a tool returned counts as given. Default true. A tool result
   * can offer the model a set of URLs to pick from, and the pick tells their
   * server something; false closes that channel.
   */
  fromTools?: boolean;
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

/** A CSS escape: hex digits (and one space after), an escaped newline (dropped), or any other character. */
const CSS_ESCAPE =
  /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([^\n\r\f0-9a-fA-F]))/g;

function unescapeCss(text: string): string {
  return text.replace(CSS_ESCAPE, (_, hex, _newline, char) => {
    if (!hex) return char ?? '';
    const code = Number.parseInt(hex, 16);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return String.fromCodePoint(valid ? code : 0xfffd);
  });
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

const URL_IN_TEXT = /(?:(?:https?|wss?|ftp):\/\/|www\.)[^\s<>\x22\x27\x60\\]+/gi;
const WWW = /^www\./i;

/** `url`, and for a `www.` autolink both schemes a renderer could give it. */
function absoluteForms(url: string): string[] {
  return WWW.test(url) ? [`http://${url}`, `https://${url}`] : [url];
}
const URL_TRAILER = new Set('.,;:!?)]}\x27\x22*_~>');

const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|([\s\S]))/g;
const JSON_CONTROL: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/** `text` with JSON string escapes decoded, as tool results and serialized history carry it. */
function unescapeJson(text: string): string {
  return text.replace(JSON_ESCAPE, (_, hex, char) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : (JSON_CONTROL[char] ?? char),
  );
}

/** No reading drops trailing punctuation one mark at a time past this many; the next drops it all. */
const MAX_TRIMS = 8;

/** `url`, then `url` less each trailing punctuation mark in turn, from the end. */
function trimmings(url: string): string[] {
  let trailing = 0;
  while (URL_TRAILER.has(url[url.length - 1 - trailing] as string)) trailing++;
  const out: string[] = [];
  for (let cut = 0; cut <= Math.min(trailing, MAX_TRIMS); cut++) {
    out.push(url.slice(0, url.length - cut));
  }
  if (trailing > MAX_TRIMS) out.push(url.slice(0, url.length - trailing));
  return out;
}

/** Adds every absolute URL in `text`, as a reader of it could have copied it. */
function addSeenUrls(seen: Set<string>, text: string): void {
  const readings = new Set([text, unescapeJson(text), decodeEntities(text).text]);
  for (const reading of readings) {
    for (const [found] of reading.matchAll(URL_IN_TEXT)) {
      for (const url of trimmings(found).flatMap(absoluteForms)) {
        const canonical = canonicalUrl(url);
        if (canonical) seen.add(canonical);
      }
    }
  }
}

function addHistoryUrls(given: GivenUrlSets, messages: readonly TurnHistoryMessage[]): void {
  for (const message of messages) {
    if (message.role === 'assistant') continue;
    addSeenUrls(message.role === 'tool' ? given.tools : given.request, textForScan(message).text);
  }
}

function addRequestUrls(
  given: GivenUrlSets,
  request: Pick<ProviderCompleteRequest, 'system' | 'input' | 'history' | 'continuation'>,
): void {
  addSeenUrls(given.request, request.system);
  addSeenUrls(given.request, textForScan(request.input).text);
  addHistoryUrls(given, request.history ?? []);
  addHistoryUrls(given, request.continuation ?? []);
}

function isGiven(canonical: string, scope: UrlScope): boolean {
  const { given } = scope;
  if (!given) return false;
  return given.request.has(canonical) || (scope.fromTools !== false && given.tools.has(canonical));
}

function hostPasses(host: string, scope: UrlScope): boolean {
  const name = host.toLowerCase();
  return (
    RESERVED_HOST.test(name) ||
    (scope.hosts?.some((allowed) => allowed.toLowerCase() === name) ?? false)
  );
}

function urlLeaks(raw: string, scope: UrlScope): boolean {
  const { text, unknown } = decodeEntities(raw.trim());
  const canonical = canonicalUrl(text);
  if (canonical && isGiven(canonical, scope)) return false;
  if (unknown) {
    const asWritten = canonicalUrl(raw.trim());
    return !(asWritten && isGiven(asWritten, scope));
  }
  if (!canonical) return false;
  return !hostPasses(new URL(canonical).hostname, scope);
}

const BARE_STOP = /[\x22\x27\x60>]/;

/**
 * Whether a bare URL leaks. Renderers disagree on where one ends: at a quote,
 * or at the next space; before trailing punctuation, or after it. Each reading
 * is checked: it passes when one reading was given and every reading goes to
 * that reading's host, or when every reading's host passes.
 */
function bareUrlLeaks(found: string, scope: UrlScope): boolean {
  const stop = found.search(BARE_STOP);
  const cuts = stop > 0 ? [found, found.slice(0, stop)] : [found];
  const readings = cuts
    .flatMap(trimmings)
    .flatMap(absoluteForms)
    .map((url) => canonicalUrl(decodeEntities(url).text))
    .filter((url): url is string => url !== undefined);
  if (readings.length === 0) return false;
  const hosts = new Set(readings.map((url) => new URL(url).hostname));
  if ([...hosts].every((host) => hostPasses(host, scope))) return false;
  return !(hosts.size === 1 && readings.some((url) => isGiven(url, scope)));
}

// ── Budget ───────────────────────────────────────────────────────────

/**
 * Constructs overlap: a destination can hold further links, a tag further
 * tags, a `<style>` block further blocks, and each is decoded on its own. One
 * read of a text decodes at most this many characters per character of it;
 * text that needs more is read as leaking throughout.
 */
const SPEND_PER_CHAR = 32;
const SPEND_BASE = 1 << 16;

interface Meter {
  spent: number;
  cap: number;
}

class Overspent extends Error {}

function capFor(length: number): number {
  return SPEND_PER_CHAR * length + SPEND_BASE;
}

function spend(meter: Meter, count: number): void {
  meter.spent += count;
  if (meter.spent > meter.cap) throw new Overspent();
}

function anyLeaks(urls: readonly string[], scope: UrlScope, meter: Meter): boolean {
  return urls.some((url) => {
    spend(meter, url.length);
    return urlLeaks(url, scope);
  });
}

type Span = { start: number; end: number };

function indicesIn(from: number, to: number, at: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) if (at(i)) out.push(i);
  return out;
}

// ── Markdown ─────────────────────────────────────────────────────────

/** A newline opening a blank line, or trailing space to the end: no bracket or code span reaches past one. */
const PARAGRAPH_BREAK = /\n[ \t]*(?=\n|$)/g;
const PARAGRAPH_BREAK_AT = /\n[ \t]*(?=\n|$)/y;

function paragraphStart(text: string, at: number): number {
  for (
    let i = text.lastIndexOf('\n', at - 1);
    i >= 0;
    i = i > 0 ? text.lastIndexOf('\n', i - 1) : -1
  ) {
    PARAGRAPH_BREAK_AT.lastIndex = i;
    if (PARAGRAPH_BREAK_AT.test(text)) return i + 1;
  }
  return 0;
}

function paragraphsFrom(text: string, start: number, last: number): [number, number][] {
  const out: [number, number][] = [];
  for (let from = start; from <= last && from < text.length; ) {
    PARAGRAPH_BREAK.lastIndex = from;
    const end = PARAGRAPH_BREAK.exec(text)?.index ?? text.length;
    out.push([from, end]);
    from = end + 1;
  }
  return out;
}

/**
 * How a renderer may read backticks: as text, as code spans within a line, or
 * as code spans across a paragraph's lines. Brackets pair differently under
 * each, and each is checked.
 */
type CodeSpans = 'none' | 'line' | 'paragraph';
const CODE_SPANS: readonly CodeSpans[] = ['none', 'line', 'paragraph'];

/** Starts of the backtick runs in [start, end), by length. */
function backtickRuns(text: string, start: number, end: number): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  for (let i = start; i < end; i++) {
    if (text[i] !== '`') continue;
    let length = 1;
    while (text[i + length] === '`') length++;
    const starts = runs.get(length);
    if (starts) starts.push(i);
    else runs.set(length, [i]);
    i += length - 1;
  }
  return runs;
}

function runIn(runs: Map<number, number[]>, length: number, from: number, before: number): number {
  const starts = runs.get(length);
  if (!starts) return -1;
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((starts[mid] as number) < from) low = mid + 1;
    else high = mid;
  }
  const at = starts[low];
  return at !== undefined && at < before ? at : -1;
}

/**
 * Where each `[` of the paragraph [start, end) closes when backticks read as
 * `spans`. An escaped `[` still opens, for a renderer lenient about escapes,
 * but the brackets around it do not count it.
 */
function bracketCloses(
  text: string,
  start: number,
  end: number,
  spans: CodeSpans,
  runs: Map<number, number[]>,
): Map<number, number> {
  const closes = new Map<number, number>();
  const open: number[] = [];
  const escaped: (number[] | undefined)[] = [];
  const skipCode = codeSkipper(text, end, spans, runs);
  for (let i = start; i < end; i++) {
    const char = text[i];
    if (char === '\\') {
      if (text[i + 1] === '[') {
        const level = escaped[open.length] ?? [];
        level.push(i + 1);
        escaped[open.length] = level;
      }
      i++;
    } else if (char === '`') i = skipCode(i);
    else if (char === '[') open.push(i);
    else if (char === ']') {
      for (const at of escaped[open.length] ?? []) closes.set(at, i);
      escaped[open.length] = undefined;
      const at = open.pop();
      if (at !== undefined) closes.set(at, i);
    }
  }
  return closes;
}

/** Where the backtick run at `i` ends, past the code span it opens when `spans` reads one there. */
function codeSkipper(
  text: string,
  end: number,
  spans: CodeSpans,
  runs: Map<number, number[]>,
): (i: number) => number {
  let lineEnd = -1;
  return (i) => {
    let length = 1;
    while (text[i + length] === '`') length++;
    if (spans === 'none') return i + length - 1;
    if (spans === 'line' && lineEnd < i) {
      lineEnd = text.indexOf('\n', i);
      if (lineEnd < 0 || lineEnd > end) lineEnd = end;
    }
    const close = runIn(runs, length, i + length, spans === 'line' ? lineEnd : end);
    return (close < 0 ? i : close) + length - 1;
  };
}

const DESTINATION_LEAD = /[ \t]*(?:\n[ \t]*)?/y;
const ANGLED_DESTINATION = /<((?:[^<>\n\\]|\\[^\n])*)>/y;
const WHITESPACE = /\s/;

/**
 * For each index of the paragraph [start, end), where a plain destination
 * starting there ends: at a space, or a `)` its own parentheses leave
 * unbalanced; `\` escapes the character after it.
 */
function destinationEnds(text: string, start: number, end: number): Int32Array {
  const ends = new Int32Array(end - start + 1);
  const endAt = (i: number) => ends[i - start] as number;
  ends[end - start] = end;
  for (let i = end - 1; i >= start; i--) {
    const char = text[i] as string;
    let stop: number;
    if (WHITESPACE.test(char) || char === ')') {
      stop = i;
    } else if (char === '\\' && i + 1 < end && !WHITESPACE.test(text[i + 1] as string)) {
      stop = endAt(i + 2);
    } else if (char === '(') {
      const inner = endAt(i + 1);
      stop = inner < end && text[inner] === ')' ? endAt(inner + 1) : inner;
    } else {
      stop = endAt(i + 1);
    }
    ends[i - start] = stop;
  }
  return ends;
}

interface Inline {
  start: number;
  open: number;
}

/**
 * The inline images or links of the paragraph [start, end) opening at
 * `openers` whose destination leaks. The destination is read up to the first
 * space whether or not a title and `)` follow, so a renderer lenient about
 * the rest still loads nothing this did not check.
 */
function paragraphLeaks(
  text: string,
  start: number,
  end: number,
  openers: readonly Inline[],
  scope: UrlScope,
  meter: Meter,
): Span[] {
  const runs = backtickRuns(text, start, end);
  const readings = (runs.size > 0 ? CODE_SPANS : CODE_SPANS.slice(0, 1)).map((spans) =>
    bracketCloses(text, start, end, spans, runs),
  );
  let ends: Int32Array | undefined;
  const destinationAfter = (close: number): { raw: string; end: number } | undefined => {
    if (text[close + 1] !== '(') return undefined;
    DESTINATION_LEAD.lastIndex = close + 2;
    DESTINATION_LEAD.test(text);
    const at = DESTINATION_LEAD.lastIndex;
    if (at >= end) return undefined;
    if (text[at] === '<') {
      ANGLED_DESTINATION.lastIndex = at;
      const angled = ANGLED_DESTINATION.exec(text);
      if (angled) return { raw: angled[1] as string, end: at + angled[0].length };
    }
    ends ??= destinationEnds(text, start, end);
    const stop = ends[at - start] as number;
    return stop > at ? { raw: text.slice(at, stop), end: stop } : undefined;
  };
  const decided = new Map<number, number | null>();
  const leakEnd = (close: number): number | null => {
    let found = decided.get(close);
    if (found === undefined) {
      const destination = destinationAfter(close);
      found =
        destination && anyLeaks([unescapeMarkdown(destination.raw)], scope, meter)
          ? destination.end
          : null;
      decided.set(close, found);
    }
    return found;
  };
  const spans: Span[] = [];
  for (const { start: from, open } of openers) {
    for (const close of new Set(readings.map((closes) => closes.get(open)))) {
      if (close === undefined) continue;
      const to = leakEnd(close);
      if (to !== null) spans.push({ start: from, end: to });
    }
  }
  return spans;
}

function inlineLeaks(
  text: string,
  openers: readonly Inline[],
  scope: UrlScope,
  meter: Meter,
): Span[] {
  const first = openers[0];
  const last = openers.at(-1);
  if (!first || !last) return [];
  const spans: Span[] = [];
  let next = 0;
  for (const [start, end] of paragraphsFrom(text, paragraphStart(text, first.start), last.open)) {
    const inside: Inline[] = [];
    while (next < openers.length && (openers[next] as Inline).open < end) {
      inside.push(openers[next++] as Inline);
    }
    if (inside.length > 0) spans.push(...paragraphLeaks(text, start, end, inside, scope, meter));
  }
  return spans;
}

function imageOpeners(text: string, from: number, to: number): Inline[] {
  return indicesIn(from, to, (i) => text[i] === '!' && text[i + 1] === '[').map((i) => ({
    start: i,
    open: i + 1,
  }));
}

/**
 * Inline links whose `[` is in [from, to). With the image check on, a `[`
 * after a `!` opens an image that check reads, so `skipImages` leaves it out.
 */
function linkOpeners(text: string, from: number, to: number, skipImages: boolean): Inline[] {
  return indicesIn(from, to, (i) => text[i] === '[' && !(skipImages && text[i - 1] === '!')).map(
    (i) => ({ start: i, open: i }),
  );
}

const DEFINITION =
  /(?:^|\n)[ ]{0,3}\[((?:[^\]\\]|\\[\s\S]){1,999})\]:[ \t]*(?:\n[ \t]*)?(<(?:[^<>\n\\]|\\[^\n])*>|\S+)/g;

/** Reference definitions whose URL leaks. Any image or link may use one, so each counts as one. */
function definitionLeaks(text: string, scope: UrlScope, meter: Meter): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(DEFINITION)) {
    const raw = match[2] as string;
    const url = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
    if (anyLeaks([unescapeMarkdown(url)], scope, meter)) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/g;

function autolinkLeaks(text: string, scope: UrlScope, meter: Meter): Span[] {
  return [...text.matchAll(AUTOLINK)]
    .filter((match) => anyLeaks([match[1] as string], scope, meter))
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

/** A URL a renderer links with no markup: a scheme or `www.`, to the next space or `<`. */
const BARE_URL = /(?:(?:https?|ftp):\/\/|www\.)[^\s<]*/gi;

function bareLinkLeaks(text: string, scope: UrlScope, meter: Meter): Span[] {
  return [...text.matchAll(BARE_URL)]
    .filter(([found]) => {
      spend(meter, found.length * (MAX_TRIMS + 2));
      return bareUrlLeaks(found, scope);
    })
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

// ── HTML ─────────────────────────────────────────────────────────────

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const EQUALS = 0x3d;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

type TagKind = 'link' | 'meta' | 'other';

function tagKind(name: string): TagKind {
  if (name === 'a' || name === 'area') return 'link';
  return name === 'meta' ? 'meta' : 'other';
}

/** No tag or attribute name this reads is longer; a longer one is read as some other name. */
const NAME_LIMIT = 16;

/** Attributes whose value the browser fetches with no click. `href` counts on every tag but a link. */
const LOADING_ATTRIBUTES = [
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
];

/** Each URL a `srcset`-like value names, every way its commas could split it. */
function listUrls(value: string): string[] {
  const urls: string[] = [];
  for (const token of value.split(/[\t\n\f\r ]+/)) {
    const bare = token.replace(/^,+|,+$/g, '');
    if (bare) urls.push(bare, ...bare.split(',').filter(Boolean));
  }
  return urls;
}

/** The URLs one attribute's raw value sends somewhere, or the document it holds (`srcdoc`). */
type AttributeValue = string[] | { document: string };

interface AttributeReader {
  /** The attributes it reads; no other carries a URL it cares about. */
  names: ReadonlySet<string>;
  read: (kind: TagKind, attribute: string, raw: string) => AttributeValue;
}

/** The URLs an attribute loads with no click. */
const LOADED: AttributeReader = {
  names: new Set([...LOADING_ATTRIBUTES, 'style', 'srcdoc', 'content', 'href']),
  read(kind, attribute, raw) {
    const value = decodeEntities(raw).text;
    if (attribute === 'style') return cssUrls(value);
    if (attribute === 'srcdoc') return { document: value };
    if (attribute === 'content') {
      const refresh = kind === 'meta' && /url\s*=\s*[\x27\x22]?([^\x27\x22]*)/i.exec(value);
      return refresh ? [refresh[1] as string] : [];
    }
    if (attribute === 'href') return kind === 'link' ? [] : [raw];
    return attribute.endsWith('srcset') || attribute === 'archive' ? listUrls(raw) : [raw];
  },
};

/** The URLs an attribute sends a click or a form to. */
const FOLLOWED: AttributeReader = {
  names: new Set(['href', 'action', 'formaction', 'ping']),
  read(kind, attribute, raw) {
    if (attribute === 'href') return kind === 'link' ? [raw] : [];
    return attribute === 'ping' ? listUrls(raw) : [raw];
  },
};

/** From an index, the first index at or after it whose character `stops`; every index passed is remembered. */
function scanner(text: string, stops: (code: number) => boolean): (from: number) => number {
  const memo = new Map<number, number>();
  return (from) => {
    let at = from;
    let found: number | undefined;
    for (; at < text.length; at++) {
      found = memo.get(at);
      if (found !== undefined) break;
      if (stops(text.charCodeAt(at))) {
        found = at;
        break;
      }
    }
    found ??= text.length;
    for (let i = from; i < at; i++) memo.set(i, found);
    return found;
  };
}

interface Attribute {
  name: string;
  from: number;
  to: number;
  next: number;
}

/** From a place between attributes: where the tag ends, the next attribute, or null when it never ends. */
type TagStep = number | Attribute | null;

/**
 * Leaking start tags whose `<` is in [from, to), read as the HTML tokenizer
 * reads them. A tag opened inside another's attributes soon reads on just as
 * the outer one does; from there both are read once.
 */
function tagLeaks(
  text: string,
  reader: AttributeReader,
  scope: UrlScope,
  meter: Meter,
  from = 0,
  to = text.length,
): Span[] {
  const length = text.length;
  const gap = scanner(text, (c) => !isSpace(c) && c !== SLASH);
  const space = scanner(text, (c) => !isSpace(c));
  const nameEnd = scanner(text, (c) => isSpace(c) || c === SLASH || c === GT || c === EQUALS);
  const tagNameEnd = scanner(text, (c) => isSpace(c) || c === SLASH || c === GT);
  const valueEnd = scanner(text, (c) => isSpace(c) || c === GT);
  const doubleQuote = scanner(text, (c) => c === DOUBLE_QUOTE);
  const singleQuote = scanner(text, (c) => c === SINGLE_QUOTE);
  const steps = new Map<number, TagStep>();
  const ends = new Map<number, number>();
  const leaks: Record<TagKind, Map<number, boolean>> = {
    link: new Map(),
    meta: new Map(),
    other: new Map(),
  };

  function readStep(i: number): TagStep {
    const at = gap(i);
    if (at >= length) return null;
    if (text.charCodeAt(at) === GT) return at + 1;
    const stop = nameEnd(at + 1);
    const name = text.slice(at, Math.min(stop, at + NAME_LIMIT + 1)).toLowerCase();
    const equals = space(stop);
    if (text.charCodeAt(equals) !== EQUALS) return { name, from: equals, to: equals, next: equals };
    const value = space(equals + 1);
    const quote = text.charCodeAt(value);
    if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
      const close = (quote === DOUBLE_QUOTE ? doubleQuote : singleQuote)(value + 1);
      return close >= length ? null : { name, from: value + 1, to: close, next: close + 1 };
    }
    const end = valueEnd(value);
    return { name, from: value, to: end, next: end };
  }

  function step(i: number): TagStep {
    let known = steps.get(i);
    if (known === undefined) {
      known = readStep(i);
      steps.set(i, known);
    }
    return known;
  }

  function endFrom(i: number): number {
    const path: number[] = [];
    let at = i;
    let end = ends.get(at);
    while (end === undefined) {
      path.push(at);
      const next = step(at);
      if (next === null) end = -1;
      else if (typeof next === 'number') end = next;
      else {
        at = next.next;
        end = ends.get(at);
      }
    }
    for (const index of path) ends.set(index, end);
    return end;
  }

  function attributeLeaks(kind: TagKind, { name, from, to }: Attribute): boolean {
    if (!reader.names.has(name)) return false;
    spend(meter, to - from);
    const value = reader.read(kind, name, text.slice(from, to));
    if (Array.isArray(value)) return anyLeaks(value, scope, meter);
    return tagLeaks(value.document, reader, scope, meter).length > 0;
  }

  function leaksFrom(i: number, kind: TagKind): boolean {
    const memo = leaks[kind];
    const path: number[] = [];
    let at = i;
    let found = memo.get(at);
    while (found === undefined) {
      const next = step(at);
      if (next === null || typeof next === 'number') {
        found = false;
        break;
      }
      path.push(at);
      if (attributeLeaks(kind, next)) {
        found = true;
        break;
      }
      at = next.next;
      found = memo.get(at);
    }
    for (const index of path) memo.set(index, found);
    return found;
  }

  const spans: Span[] = [];
  const opens = indicesIn(
    from,
    to,
    (i) => text.charCodeAt(i) === LT && isLetter(text.charCodeAt(i + 1)),
  );
  for (const open of opens) {
    const afterName = tagNameEnd(open + 1);
    const kind = tagKind(
      text.slice(open + 1, Math.min(afterName, open + 1 + NAME_LIMIT)).toLowerCase(),
    );
    const end = endFrom(afterName);
    if (end >= 0 && leaksFrom(afterName, kind)) spans.push({ start: open, end });
  }
  return spans;
}

// ── CSS ──────────────────────────────────────────────────────────────

const CSS_NAME =
  /(?:[A-Za-z0-9_\-\u0080-￿]|\\(?:[0-9a-fA-F]{1,6}(?:\r\n|[ \t\n\r\f])?|[^\n\r\f0-9a-fA-F]))+/y;
const CSS_STRING = {
  '"': /(?:[^\x22\\\n\r\f]|\\(?:\r\n|[\s\S]))*/y,
  "'": /(?:[^\x27\\\n\r\f]|\\(?:\r\n|[\s\S]))*/y,
};
const CSS_URL_BODY = /(?:[^)\\]|\\[\s\S])*/y;

/**
 * Every URL CSS could load, read as the CSS tokenizer reads it: each
 * `url()`, and each string (`@import "..."`, `image-set("...")`). Comments
 * hide what is in them; escapes are decoded in each token, not before, so an
 * escaped `)` or quote stays inside it.
 */
function cssUrls(css: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < css.length) {
    const char = css[i] as string;
    if (char === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? css.length : close + 2;
    } else if (char === '"' || char === "'") {
      const string = CSS_STRING[char];
      string.lastIndex = i + 1;
      urls.push(unescapeCss((string.exec(css) as RegExpExecArray)[0]));
      i = string.lastIndex + 1;
    } else {
      CSS_NAME.lastIndex = i;
      const name = CSS_NAME.exec(css)?.[0];
      if (!name) {
        i++;
        continue;
      }
      i += name.length;
      if (css[i] !== '(' || unescapeCss(name).toLowerCase() !== 'url') continue;
      let at = i + 1;
      while (isSpace(css.charCodeAt(at))) at++;
      if (css[at] === '"' || css[at] === "'") {
        i = at;
        continue;
      }
      CSS_URL_BODY.lastIndex = at;
      urls.push(unescapeCss((CSS_URL_BODY.exec(css) as RegExpExecArray)[0]).trim());
      i = CSS_URL_BODY.lastIndex + 1;
    }
  }
  return urls;
}

const STYLE_OPEN = /<style[\t\n\f\r />]/iy;
const STYLE_CLOSE = /<\/style[\t\n\f\r />]/gi;

/** Leaking `<style>` blocks opening in [from, to), each to the tag that closes one or the end. The browser applies what it has. */
function styleLeaks(
  text: string,
  scope: UrlScope,
  meter: Meter,
  from = 0,
  to = text.length,
): Span[] {
  const spans: Span[] = [];
  let close = -1;
  const opens = indicesIn(from, to, (i) => {
    if (text.charCodeAt(i) !== LT) return false;
    STYLE_OPEN.lastIndex = i;
    return STYLE_OPEN.test(text);
  });
  for (const open of opens) {
    const content = open + '<style '.length;
    if (close < content) {
      STYLE_CLOSE.lastIndex = content;
      close = STYLE_CLOSE.exec(text)?.index ?? text.length;
    }
    const css = text.slice(content, close);
    spend(meter, css.length);
    if (anyLeaks(cssUrls(css), scope, meter)) {
      spans.push({ start: open, end: Math.min(text.length, close + '</style>'.length) });
    }
  }
  return spans;
}

// ── Checks ───────────────────────────────────────────────────────────

/** `read`'s spans, sorted; all of `text` when reading it would decode past its cap. */
function readFailingClosed(text: string, read: (meter: Meter) => Span[]): Span[] {
  try {
    return read({ spent: 0, cap: capFor(text.length) }).sort((a, b) => a.start - b.start);
  } catch (error) {
    if (error instanceof Overspent) return [{ start: 0, end: text.length }];
    throw error;
  }
}

function imageLeakSpans(text: string, scope: UrlScope): Span[] {
  return readFailingClosed(text, (meter) => [
    ...inlineLeaks(text, imageOpeners(text, 0, text.length), scope, meter),
    ...(/!\[/.test(text) ? definitionLeaks(text, scope, meter) : []),
    ...tagLeaks(text, LOADED, scope, meter),
    ...styleLeaks(text, scope, meter),
  ]);
}

/** With `skipImages`, an image's own markup is left to the image check. */
function linkLeakSpans(text: string, scope: UrlScope, skipImages: boolean): Span[] {
  return readFailingClosed(text, (meter) => [
    ...inlineLeaks(text, linkOpeners(text, 0, text.length, skipImages), scope, meter),
    ...definitionLeaks(text, scope, meter),
    ...autolinkLeaks(text, scope, meter),
    ...bareLinkLeaks(text, scope, meter),
    ...tagLeaks(text, FOLLOWED, scope, meter),
  ]);
}

// ── Streaming ────────────────────────────────────────────────────────

/**
 * A start tag as the tokenizer reads it, up to the `>` that ends it. Each
 * name, value and run of space is read one way only (the lookaheads end each
 * where the tokenizer does), so a tag that never ends fails in linear time.
 */
const HTML_START_TAG =
  /<[A-Za-z][^\t\n\f\r />]*(?=[\t\n\f\r />])(?:[\t\n\f\r /]|[^\t\n\f\r />][^\t\n\f\r />=]*(?=[\t\n\f\r />=])[\t\n\f\r ]*(?![\t\n\f\r ])(?:=[\t\n\f\r ]*(?![\t\n\f\r ])(?:\x22[^\x22]*\x22|\x27[^\x27]*\x27|[^\t\n\f\r >\x22\x27][^\t\n\f\r >]*(?=[\t\n\f\r >])|(?=>))|(?!=)))*>/g;

/**
 * Patterns covering every image a renderer could read, for the streaming hold.
 * Each match is at least as long as the image it holds for: an inline image
 * runs to the end of its paragraph, a tag to the `>` the tokenizer ends it at,
 * a `<style>` block to the tag that closes it.
 */
const IMAGE_PATTERNS: readonly RegExp[] = [
  /!\[(?:[^\n]|\n[ \t]*\S)*(?:\n[ \t]*)?\]\([ \t]*(?:\n[ \t]*)?(?:<(?:[^<>\n\\]|\\[^\n])*>|(?:[^\s\\]|\\\S)+)/g,
  DEFINITION,
  /!\[/g,
  HTML_START_TAG,
  /<style[\t\n\f\r />][\s\S]*?<\/style[\t\n\f\r />]/gi,
];

/** Patterns covering every link a renderer could read, as `IMAGE_PATTERNS` do images. */
const LINK_PATTERNS: readonly RegExp[] = [
  /\[(?:[^\n]|\n[ \t]*\S)*(?:\n[ \t]*)?\]\([ \t]*(?:\n[ \t]*)?(?:<(?:[^<>\n\\]|\\[^\n])*>|(?:[^\s\\]|\\\S)+)/g,
  DEFINITION,
  AUTOLINK,
  BARE_URL,
  HTML_START_TAG,
];

/** Where the first leak among the constructs starting in a settled stretch [from, to) of the reply starts. */
type UrlFinder = (reply: string, from: number, to: number) => number | undefined;

/** Whether a settled regex match at `at` leaks, read with the reply so far. */
type UrlMatchTest = (match: string, reply: string, at: number) => boolean;

/**
 * How the stream reads one URL pattern: constructs that can nest are read by
 * a finder over each settled stretch, each once; the rest by testing each
 * match of the pattern.
 */
type UrlPatternReading = { find: UrlFinder } | { test: UrlMatchTest };

type StretchRead = (reply: string, from: number, to: number, meter: Meter) => Span[];
type MatchRead = { match: (match: string, reply: string, at: number, meter: Meter) => boolean };

/**
 * One reply's readings, charging one meter whose cap grows with the reply.
 * What would decode past it leaks: a stretch from its start, a match whole.
 */
function metered(reads: readonly (StretchRead | MatchRead)[]): UrlPatternReading[] {
  const meter: Meter = { spent: 0, cap: 0 };
  return reads.map((read) => {
    if (typeof read === 'function') {
      return {
        find(reply, from, to) {
          meter.cap = capFor(reply.length);
          try {
            const starts = read(reply, from, to, meter).map(({ start }) => start);
            return starts.length > 0 ? Math.min(...starts) : undefined;
          } catch (error) {
            if (error instanceof Overspent) return from;
            throw error;
          }
        },
      };
    }
    return {
      test(match, reply, at) {
        meter.cap = capFor(reply.length);
        try {
          return read.match(match, reply, at, meter);
        } catch (error) {
          if (error instanceof Overspent) return true;
          throw error;
        }
      },
    };
  });
}

/**
 * The readings of `IMAGE_PATTERNS`, in its order. A definition leaks once any
 * image could use it, and an image opener once a leaking definition has
 * settled; the reply is read once overall for openers.
 */
function imageReadings(scope: UrlScope): UrlPatternReading[] {
  let opener = false;
  let scanned = 0;
  let leakingDefinition = false;
  const openerIn = (reply: string): boolean => {
    opener ||= reply.indexOf('![', Math.max(0, scanned - 1)) !== -1;
    scanned = reply.length;
    return opener;
  };
  return metered([
    (reply, from, to, meter) => inlineLeaks(reply, imageOpeners(reply, from, to), scope, meter),
    {
      match(match, reply, _at, meter) {
        const leaks = definitionLeaks(match, scope, meter).length > 0;
        leakingDefinition ||= leaks;
        return leaks && openerIn(reply);
      },
    },
    { match: () => leakingDefinition },
    (reply, from, to, meter) => tagLeaks(reply, LOADED, scope, meter, from, to),
    (reply, from, to, meter) => styleLeaks(reply, scope, meter, from, to),
  ]);
}

function linkReadings(scope: UrlScope, skipImages: boolean): UrlPatternReading[] {
  return metered([
    (reply, from, to, meter) =>
      inlineLeaks(reply, linkOpeners(reply, from, to, skipImages), scope, meter),
    { match: (match, _reply, _at, meter) => definitionLeaks(match, scope, meter).length > 0 },
    { match: (match, _reply, _at, meter) => autolinkLeaks(match, scope, meter).length > 0 },
    { match: (match, _reply, _at, meter) => bareLinkLeaks(match, scope, meter).length > 0 },
    (reply, from, to, meter) => tagLeaks(reply, FOLLOWED, scope, meter, from, to),
  ]);
}

export type { GivenUrlSets, GivenUrls, Span, UrlFinder, UrlMatchTest, UrlPatternReading, UrlScope };
export {
  addHistoryUrls,
  addRequestUrls,
  addSeenUrls,
  givenUrlSets,
  IMAGE_PATTERNS,
  imageLeakSpans,
  imageReadings,
  LINK_PATTERNS,
  linkLeakSpans,
  linkReadings,
};
