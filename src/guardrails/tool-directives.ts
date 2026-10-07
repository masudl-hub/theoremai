import { typoFolded } from './injection.ts';
import { overrideFrame } from './injection-patterns.ts';
import { normalizeForDetection } from './normalize.ts';
import type { AdvisoryLevel } from './types.ts';

/**
 * Imperatives aimed at an agent rather than a reader.
 *
 * Bounded quantifiers throughout: tool results can be large, and an unbounded
 * scanner on attacker-controlled bytes is a denial-of-service surface.
 */
const IMPERATIVES: RegExp[] = [
  /\b(?:next|final|remaining)\s+steps?\s*[:—-]/gi,
  /\byou\s+(?:must|should|need\s+to|are\s+required\s+to)\s+(?:now\s+)?\w{2,20}/gi,
  /\bto\s+(?:complete|finish|fulfil|fulfill)\s+(?:this|the)\s+\w{2,20}/gi,
  /\b(?:call|invoke|run|execute)\s+(?:the\s+)?[\w.-]{2,40}\s+(?:tool|function)\b/gi,
  /\b(?:send|forward|email|transfer|upload|post)\s+(?:the\s+|all\s+|your\s+)?[\w\s]{2,40}\s+to\s+\S{3,80}/gi,
  /\b(?:delete|remove|drop|purge)\s+(?:the\s+|all\s+)?[\w\s]{2,40}\b/gi,
];

/**
 * A concrete external destination — the thing exfiltration needs and ordinary
 * process prose almost never carries.
 *
 * This is the discriminator. Directive language on its own is everywhere in
 * legitimate tool output: documentation says "you must be an admin", support
 * articles say "to remove a user", status reports say "the user has approved".
 * Measured on a benign sample, directive signals alone produced false positives
 * on most of it. Pairing a signal with a destination removed all of them.
 *
 * The pairing is close. A web page always carries an address somewhere, and a
 * shop's page says "Remove This Item" and "if you need to exchange it, send us
 * an email at …": of 20 real search results, a destination anywhere in the
 * result flagged 3. An order or a claim counts when the destination is in what
 * it orders, up to the next comma; a tool's name when one is in its sentence.
 */
const EXFIL_TARGET = /\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}\b|\bhttps?:\/\/\S{4,120}/i;
const EXFIL_TARGETS = new RegExp(EXFIL_TARGET.source, 'gi');

/** How far from a signal its sentence is read, where the text has no sentence ends. */
const SENTENCE_REACH = 240;

/** Whether a sentence of `text` ends at `at`: a line break, or `.`, `!` or `?` before a space. */
function endsSentence(text: string, at: number): boolean {
  const ch = text[at];
  if (ch === '\n') return true;
  return (ch === '.' || ch === '!' || ch === '?') && /\s/.test(text[at + 1] ?? ' ');
}

/** Whether a clause of `text` ends at `at`: where a sentence does, or at `,` or `;` before a space. */
function endsClause(text: string, at: number): boolean {
  const ch = text[at];
  return endsSentence(text, at) || ((ch === ',' || ch === ';') && /\s/.test(text[at + 1] ?? ' '));
}

/** Where the stretch of `text` from `end` stops: at the first place `ends` holds, at most `SENTENCE_REACH` on. */
function reachFrom(text: string, end: number, ends: (text: string, at: number) => boolean): number {
  let to = end;
  const ceiling = Math.min(text.length, end + SENTENCE_REACH);
  while (to < ceiling && !ends(text, to)) to += 1;
  return to;
}

/** Where the sentence of `text` holding `start` begins, at most `SENTENCE_REACH` back. */
function sentenceStart(text: string, start: number): number {
  let from = start;
  const floor = Math.max(0, start - SENTENCE_REACH);
  while (from > floor && !endsSentence(text, from - 1)) from -= 1;
  return from;
}

/** Claims of permission or provenance the content cannot actually hold. */
const AUTHORITY: RegExp[] = [
  /\b(?:the\s+)?user\s+has\s+(?:already\s+)?(?:approved|authorised|authorized|confirmed|requested)\b/gi,
  /\b(?:system|admin|operator)\s+(?:note|notice|message|override|instruction)s?\s*[:—-]/gi,
  /\bon\s+behalf\s+of\s+the\s+(?:user|operator|admin)\b/gi,
  /\bthis\s+(?:is|was)\s+(?:pre-?)?(?:approved|authorised|authorized)\b/gi,
];

/**
 * An order to set instructions aside. Data has no reason to address the
 * agent's instructions, so here the order counts when negated and with more
 * words between its verb and its object than `injection-patterns.ts` allows.
 */
const OVERRIDE = [new RegExp(overrideFrame(5), 'gi')];

/** A stretch of a text, from its first index to the one after its last. */
type Range = [start: number, end: number];

/** Every destination in `text` between `from` and `to`. */
function targetsIn(text: string, from: number, to: number): Range[] {
  return [...text.slice(from, to).matchAll(EXFIL_TARGETS)].map((match) => [
    from + match.index,
    from + match.index + match[0].length,
  ]);
}

/** Each match of `patterns` in `text` that names a destination before its clause ends, and the destinations it names. */
function directsOut(patterns: RegExp[], text: string): Range[] {
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].flatMap((match): Range[] => {
      const end = match.index + match[0].length;
      const targets = targetsIn(text, match.index, reachFrom(text, end, endsClause));
      return targets.length > 0 ? [[match.index, end], ...targets] : [];
    }),
  );
}

/** Each order in `text` to set instructions aside, read with its misspellings put right. */
function overrides(text: string): Range[] {
  const folded = typoFolded(text);
  return OVERRIDE.flatMap((pattern) =>
    [...folded.text.matchAll(pattern)].map(
      (match): Range => [folded.at(match.index), folded.at(match.index + match[0].length - 1) + 1],
    ),
  );
}

function isToolNameBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9_-]/i.test(ch);
}

/**
 * Where `text` names `tool`, at word boundaries, in a sentence with a
 * destination: the name, and the destinations of its sentence. A name inside a
 * destination (`https://shop.example/search`) is part of the address. Registry
 * input is not compiled as a pattern.
 */
function directsToTool(text: string, tool: string): Range[] {
  if (tool.length < 3) {
    return [];
  }
  const haystack = text.toLowerCase();
  const needle = tool.toLowerCase();
  const found: Range[] = [];
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const end = at + needle.length;
    if (isToolNameBoundary(haystack[at - 1]) && isToolNameBoundary(haystack[end])) {
      const targets = targetsIn(text, sentenceStart(text, at), reachFrom(text, end, endsSentence));
      const isInTarget = targets.some(([start, stop]) => start <= at && end <= stop);
      if (targets.length > 0 && !isInTarget) {
        found.push([at, end], ...targets);
      }
    }
    at = haystack.indexOf(needle, end);
  }
  return found;
}

/**
 * What of a tool's text reads as an instruction to the agent: an order to set its instructions
 * aside, the name of a tool it can call, an order, or a claim of authority. The last three count
 * only beside a destination.
 */
const DIRECTIVE_SIGNALS = ['override', 'tool_name', 'order', 'authority'] as const;
/** One of {@linkcode DIRECTIVE_SIGNALS}. */
type DirectiveSignal = (typeof DIRECTIVE_SIGNALS)[number];

/** A stretch of a tool's text that instructs the agent, and what about it does. */
interface Directive {
  signal: DirectiveSignal;
  start: number;
  end: number;
}

/** One range for each run of overlapping `ranges`, in order. */
function mergedRanges(ranges: readonly [number, number][]): [number, number][] {
  const runs: [number, number][] = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = runs.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else runs.push([start, end]);
  }
  return runs;
}

/** One directive for each run of overlapping `ranges`. */
function directivesOf(signal: DirectiveSignal, ranges: readonly Range[]): Directive[] {
  return mergedRanges(ranges).map(([start, end]) => ({ signal, start, end }));
}

/**
 * Real indirect injection rarely names what it attacks, so this looks for content that behaves
 * like an instruction: each order, claim of authority, tool name and destination, where it sits
 * in `text`. A page documenting an email API legitimately says "call send_email", so the
 * detector that reads with this (`tool_instructions`) starts at `flag`.
 *
 * `callableTools` is the set the model can invoke this turn. A result naming one is the
 * highest-precision signal: ordinary data has no reason to, and no generic filter can check it
 * without the turn's registry.
 *
 * The text is read normalized. Where that changes it, an index of what was read is not one of
 * `text`, and each signal found is the whole text once.
 */
function directives(text: string, callableTools: readonly string[] = []): Directive[] {
  if (!text) {
    return [];
  }
  const normalized = normalizeForDetection(text);
  const found = directivesOf('override', overrides(normalized));
  // why: No destination, no exfiltration. Action-shaped attacks that carry no target
  // are left to the taint gate, which does not depend on reading the content.
  if (EXFIL_TARGET.test(normalized)) {
    found.push(
      ...directivesOf(
        'tool_name',
        callableTools.flatMap((tool) => directsToTool(normalized, tool)),
      ),
      ...directivesOf('order', directsOut(IMPERATIVES, normalized)),
      ...directivesOf('authority', directsOut(AUTHORITY, normalized)),
    );
  }
  if (normalized === text) return found;
  return DIRECTIVE_SIGNALS.filter((signal) => found.some((one) => one.signal === signal)).map(
    (signal) => ({ signal, start: 0, end: text.length }),
  );
}

/**
 * How strongly a tool's text reads as instructions, by the `signals` found in it: `high` for an
 * order to drop instructions, a callable tool's name, or two signals together.
 */
function advisoryLevel(signals: readonly (string | undefined)[]): AdvisoryLevel {
  if (signals.length === 0) {
    return 'none';
  }
  const kinds = new Set(signals);
  return kinds.has('tool_name') || kinds.has('override') || kinds.size > 1 ? 'high' : 'elevated';
}

export type { Directive, DirectiveSignal };
export { advisoryLevel, DIRECTIVE_SIGNALS, directives, mergedRanges };
