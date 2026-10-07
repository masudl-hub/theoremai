/**
 * A hijacked agent has to send what it took somewhere, and the hijacker has to
 * say where. A destination is an email address, the host of a link, or a bank
 * account number. A tool call is reported when one of its arguments carries a
 * destination that this turn read in the running text of a remote tool's
 * result, and that nothing the user, the system prompt or a host tool gave.
 *
 * A destination that is the whole value of a field in the result (an email's
 * `sender`, a search result's `url`) is data the tool returned, so the model
 * may use it: only one written into prose counts.
 *
 * @module
 */

import type { TurnHistoryMessage } from '../kernel/turn-events.ts';
import type { ProviderCompleteRequest } from '../kernel/types.ts';
import { type LexiconOverrides, lexiconText } from './lexicon.ts';
import { TOOL_RULES } from './rules.ts';
import { textForScan } from './serialize.ts';
import { isRemoteOrigin } from './tool-result.ts';
import type { Provenance, ResolvedGuardrailPolicy, Verdict } from './types.ts';

/** What the turn has read so far, by who wrote it. Keys are `kind:value`, lowercased. */
interface TurnDestinations {
  /** From the system prompt, the user, host history and local tools. */
  given: Set<string>;
  /** From the running text of remote tool results, with the tool that returned each. */
  remote: Map<string, string>;
}

function turnDestinations(): TurnDestinations {
  return { given: new Set(), remote: new Map() };
}

interface Found {
  key: string;
  start: number;
  end: number;
}

const LOCAL_PART = /[\p{L}\p{N}_.+-]/u;
const DOMAIN = /[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/uy;
const LINK = /(?:https?:\/\/|www\.)[^\s'"<>)\]]+/gi;
/** An IBAN's shape: two letters, two check digits, then the account. */
const ACCOUNT = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const HOST_END = /[/?#]/;

/** Read outward from each `@`, so a long run of letters with no address in it is read once. */
function emailsIn(text: string): Found[] {
  const found: Found[] = [];
  let at = text.indexOf('@');
  while (at >= 0) {
    let start = at;
    while (start > 0 && LOCAL_PART.test(text.charAt(start - 1))) start -= 1;
    DOMAIN.lastIndex = at + 1;
    const domain = start < at ? DOMAIN.exec(text) : null;
    if (domain) {
      const end = at + 1 + domain[0].length;
      found.push({ key: `email:${text.slice(start, end).toLowerCase()}`, start, end });
      at = text.indexOf('@', end);
    } else {
      at = text.indexOf('@', at + 1);
    }
  }
  return found;
}

/** Two links to one server are one destination, whatever their paths. */
function hostOf(link: string): string {
  const afterScheme = link.replace(/^https?:\/\//i, '');
  const end = afterScheme.search(HOST_END);
  const authority = end < 0 ? afterScheme : afterScheme.slice(0, end);
  const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
  return host
    .toLowerCase()
    .replace(/[.,]+$/, '')
    .replace(/^www\./, '');
}

function destinationsIn(text: string): Found[] {
  const emails = emailsIn(text);
  let rest = text;
  for (const { start, end } of emails) {
    rest = rest.slice(0, start) + ' '.repeat(end - start) + rest.slice(end);
  }
  const found = [...emails];
  for (const match of [...rest.matchAll(LINK)]) {
    const host = hostOf(match[0]);
    if (host) {
      found.push({ key: `host:${host}`, start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of [...rest.matchAll(ACCOUNT)]) {
    found.push({
      key: `account:${match[0].toLowerCase()}`,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
}

/** JSON a tool returned as text has fields too. */
function parsedJson(text: string): unknown {
  const first = text.trimStart().charAt(0);
  if (first !== '{' && first !== '[') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const MAX_DEPTH = 32;

function eachString(value: unknown, visit: (text: string) => void, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    const parsed = parsedJson(value);
    if (parsed === undefined) visit(value);
    else eachString(parsed, visit, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) eachString(item, visit, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) eachString(item, visit, depth + 1);
  }
}

/** Every destination in `value`'s strings; `inProse` leaves out one that is a string's whole value. */
function destinationKeys(value: unknown, inProse = false): Set<string> {
  const keys = new Set<string>();
  eachString(value, (text) => {
    const trimmed = text.trim();
    const found = destinationsIn(trimmed);
    const [only] = found;
    const whole = found.length === 1 && only?.start === 0 && only.end === trimmed.length;
    if (inProse && whole) return;
    for (const { key } of found) keys.add(key);
  });
  return keys;
}

/** Notes every destination in `value`'s strings as given. */
function addGivenDestinations(turn: TurnDestinations, value: unknown): void {
  for (const key of destinationKeys(value)) turn.given.add(key);
}

/** Notes what the user and the host said in `messages`. */
function addHistoryDestinations(
  turn: TurnDestinations,
  messages: readonly TurnHistoryMessage[],
  own: WeakSet<object>,
): void {
  for (const message of messages) {
    // why: An earlier turn's tool result is neither the user's word nor this turn's read.
    if (message.role === 'assistant' || message.role === 'tool' || own.has(message)) continue;
    addGivenDestinations(turn, textForScan(message).text);
  }
}

/** Notes what a provider request gives the model. `own` holds what quotes the model's own words. */
function addRequestDestinations(
  turn: TurnDestinations,
  request: Pick<ProviderCompleteRequest, 'system' | 'input' | 'history' | 'continuation'>,
  own: WeakSet<object>,
): void {
  addGivenDestinations(turn, request.system);
  if (!own.has(request.input)) addGivenDestinations(turn, textForScan(request.input).text);
  addHistoryDestinations(turn, request.history ?? [], own);
  addHistoryDestinations(turn, request.continuation ?? [], own);
}

/**
 * Notes what a tool result gives the model. A local tool runs the host's own
 * code, so what it returns is given, as for taint.
 */
function addResultDestinations(
  turn: TurnDestinations,
  result: { finding: string; data?: unknown },
  provenance: Provenance,
): void {
  if (!isRemoteOrigin(provenance.origin)) {
    addGivenDestinations(turn, [result.finding, result.data]);
    return;
  }
  const structured = parsedJson(result.finding);
  const prose = new Set([
    ...(structured === undefined
      ? destinationKeys(result.finding)
      : destinationKeys(structured, true)),
    ...destinationKeys(result.data, true),
  ]);
  for (const key of prose) {
    if (!turn.remote.has(key)) turn.remote.set(key, provenance.tool);
  }
}

/** A call's verdict, and what an approval card says when the profile asks the user first. */
interface DestinationVerdict {
  verdict: Verdict;
  /** Set when the profile holds the call for the user's answer. */
  confirm?: string;
}

/**
 * Reported whether or not the profile acts on it, so a host sees how often the
 * rule would hold a call before it turns that on.
 */
function checkDestinationGate(
  turn: TurnDestinations | undefined,
  args: unknown,
  policy: ResolvedGuardrailPolicy,
  lexicon?: LexiconOverrides,
): DestinationVerdict {
  if (!turn || turn.remote.size === 0) return { verdict: { action: 'allow' } };
  const found = [...destinationKeys(args)].filter(
    (key) => turn.remote.has(key) && !turn.given.has(key),
  );
  if (found.length === 0) return { verdict: { action: 'allow' } };
  const values = found.map((key) => key.slice(key.indexOf(':') + 1));
  const hits = values.map((match) => ({
    rule: TOOL_RULES.remoteDestination,
    severity: 'high' as const,
    match,
  }));
  const said = {
    destination: values.join(', '),
    sources: [...new Set(found.map((key) => turn.remote.get(key) ?? ''))].join(', '),
  };
  const action = policy.taint?.remoteDestination ?? 'off';
  if (action === 'block') {
    return {
      verdict: {
        action: 'block',
        hits,
        rejection: lexiconText('taint.destination_blocked', said, lexicon),
      },
    };
  }
  return {
    verdict: { action: 'flag', hits },
    ...(action === 'confirm'
      ? { confirm: lexiconText('taint.destination_confirm', said, lexicon) }
      : {}),
  };
}

export type { DestinationVerdict, TurnDestinations };
export {
  addGivenDestinations,
  addHistoryDestinations,
  addRequestDestinations,
  addResultDestinations,
  checkDestinationGate,
  turnDestinations,
};
