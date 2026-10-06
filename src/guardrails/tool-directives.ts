import { typoNormalize } from './injection.ts';
import { overrideFrame } from './injection-patterns.ts';
import { normalizeForDetection } from './normalize.ts';
import { DIRECTIVE_RULES } from './rules.ts';
import type { AdvisoryLevel, GuardrailHit } from './types.ts';

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

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/** Whether some match of `patterns` in `text` names a destination before its clause ends. */
function directsOut(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) =>
    text
      .matchAll(pattern)
      .some((match) =>
        EXFIL_TARGET.test(
          text.slice(match.index, reachFrom(text, match.index + match[0].length, endsClause)),
        ),
      ),
  );
}

function isToolNameBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9_-]/i.test(ch);
}

/**
 * Whether `text` names `tool`, at word boundaries, in a sentence with a
 * destination. A name inside a destination (`https://shop.example/search`) is
 * part of the address. Registry input is not compiled as a pattern.
 */
function directsToTool(text: string, tool: string): boolean {
  if (tool.length < 3) {
    return false;
  }
  const haystack = text.toLowerCase();
  const needle = tool.toLowerCase();
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const end = at + needle.length;
    if (isToolNameBoundary(haystack[at - 1]) && isToolNameBoundary(haystack[end])) {
      const from = sentenceStart(text, at);
      const targets = text
        .slice(from, reachFrom(text, end, endsSentence))
        .matchAll(EXFIL_TARGETS)
        .map((match) => ({ start: from + match.index, end: from + match.index + match[0].length }))
        .toArray();
      const isInTarget = targets.some((target) => target.start <= at && end <= target.end);
      if (targets.length > 0 && !isInTarget) {
        return true;
      }
    }
    at = haystack.indexOf(needle, end);
  }
  return false;
}

/**
 * Real indirect injection rarely names what it attacks, so this looks for content that behaves
 * like an instruction. Hits raise the turn's taint rather than rewriting the text: a page
 * documenting an email API legitimately says "call send_email", and being wrong should cost a
 * refused write, not silently damaged input.
 *
 * `callableTools` is the set the model can invoke this turn. A result naming one is the
 * highest-precision signal: ordinary data has no reason to, and no generic filter can check it
 * without the turn's registry.
 */
function directiveHits(text: string, callableTools: readonly string[] = []): GuardrailHit[] {
  if (!text) {
    return [];
  }
  const normalized = normalizeForDetection(text);
  const hits: GuardrailHit[] = [];
  if (matches(OVERRIDE, typoNormalize(normalized))) {
    hits.push({ rule: DIRECTIVE_RULES.override, severity: 'high' });
  }
  if (!EXFIL_TARGET.test(normalized)) {
    // why: No destination, no exfiltration. Action-shaped attacks that carry no target
    // are left to the taint gate, which does not depend on reading the content.
    return hits;
  }

  // why: One hit per named tool — several names is a stronger signal than one.
  for (const _tool of callableTools.filter((tool) => directsToTool(normalized, tool))) {
    hits.push({ rule: DIRECTIVE_RULES.toolName, severity: 'high' });
  }
  if (directsOut(IMPERATIVES, normalized)) {
    hits.push({ rule: DIRECTIVE_RULES.imperative, severity: 'medium' });
  }
  if (directsOut(AUTHORITY, normalized)) {
    hits.push({ rule: DIRECTIVE_RULES.authority, severity: 'medium' });
  }
  return hits;
}

/** True when there is at least one directive hit. */
function looksDirective(hits: GuardrailHit[]): boolean {
  return hits.length > 0;
}

function advisoryLevel(hits: GuardrailHit[]): AdvisoryLevel {
  if (hits.length === 0) {
    return 'none';
  }
  const kinds = new Set(hits.map((hit) => hit.rule));
  if (
    kinds.has(DIRECTIVE_RULES.toolName) ||
    kinds.has(DIRECTIVE_RULES.override) ||
    kinds.size > 1
  ) {
    return 'high';
  }
  return 'elevated';
}

export { advisoryLevel, directiveHits, looksDirective };
