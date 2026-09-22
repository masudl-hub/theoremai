/**
 * Directive detection for tool ingress.
 *
 * Tool results carry a different threat than user text. The jailbreak phrasings in
 * `injection.ts` name the thing they attack — "ignore previous instructions",
 * "reveal your system prompt" — and real indirect injection rarely does. It reads
 * like a status update or a helpful next step, and pattern-matching for the word
 * "instructions" misses all of it.
 *
 * What is anomalous in *data* is content that behaves like an instruction: naming
 * a tool the agent can call, issuing an imperative at the agent, or claiming an
 * authority the content does not have.
 *
 * A signal only counts when it co-occurs with a concrete external destination —
 * an address or URL. Directive language alone is far too common in legitimate
 * output to act on. These signals raise the turn's taint rather than rewriting the text. A page
 * documenting an email API legitimately says "call send_email"; redacting that
 * would corrupt content the model needs. Being wrong here should cost a refused
 * write — recoverable and visible — not silently damaged input.
 *
 * @module
 */

import { normalizeForDetection } from './normalize.ts';
import type { AdvisoryLevel, GuardrailHit } from './types.ts';

/** Rule ids emitted by tool-ingress directive detection. */
export const DIRECTIVE_RULES = {
  toolName: 'tool_result.names-callable-tool',
  imperative: 'tool_result.imperative',
  authority: 'tool_result.authority-claim',
} as const;

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
 */
const EXFIL_TARGET = /\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}\b|\bhttps?:\/\/\S{4,120}/i;

/** Claims of permission or provenance the content cannot actually hold. */
const AUTHORITY: RegExp[] = [
  /\b(?:the\s+)?user\s+has\s+(?:already\s+)?(?:approved|authorised|authorized|confirmed|requested)\b/gi,
  /\b(?:system|admin|operator)\s+(?:note|notice|message|override|instruction)s?\s*[:—-]/gi,
  /\bon\s+behalf\s+of\s+the\s+(?:user|operator|admin)\b/gi,
  /\bthis\s+(?:is|was)\s+(?:pre-?)?(?:approved|authorised|authorized)\b/gi,
];

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function isToolNameBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9_-]/i.test(ch);
}

/** Word-boundary match for a tool name without compiling registry input as a pattern. */
function mentionsTool(text: string, tool: string): boolean {
  if (tool.length < 3) {
    return false;
  }
  const haystack = text.toLowerCase();
  const needle = tool.toLowerCase();
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if (isToolNameBoundary(before) && isToolNameBoundary(after)) {
      return true;
    }
    at = haystack.indexOf(needle, at + needle.length);
  }
  return false;
}

/**
 * Detect instruction-shaped content in a tool result.
 *
 * `callableTools` is the set the model can actually invoke this turn. A result
 * naming one is the highest-precision signal available — ordinary data has no
 * reason to name the agent's tools, and no generic content filter can check it
 * because it requires the turn's registry.
 */
function directiveHits(text: string, callableTools: readonly string[] = []): GuardrailHit[] {
  if (!text || !EXFIL_TARGET.test(text)) {
    // No destination, no exfiltration. Action-shaped attacks that carry no target
    // are left to the taint gate, which does not depend on reading the content.
    return [];
  }
  const normalized = normalizeForDetection(text);
  const hits: GuardrailHit[] = [];

  // One hit per named tool — several names is a stronger signal than one.
  for (const _tool of callableTools.filter((tool) => mentionsTool(normalized, tool))) {
    hits.push({ rule: DIRECTIVE_RULES.toolName, severity: 'high' });
  }
  if (matches(IMPERATIVES, normalized)) {
    hits.push({ rule: DIRECTIVE_RULES.imperative, severity: 'medium' });
  }
  if (matches(AUTHORITY, normalized)) {
    hits.push({ rule: DIRECTIVE_RULES.authority, severity: 'medium' });
  }
  return hits;
}

/** True when a result looked like it was trying to steer the agent. */
function looksDirective(hits: GuardrailHit[]): boolean {
  return hits.length > 0;
}

/**
 * Strength of the signals, read off the hits rather than invented.
 *
 * Naming a tool the model can call is the sharpest signal available, so it alone
 * reaches `high`; so does agreement between two different signal kinds.
 */
function advisoryLevel(hits: GuardrailHit[]): AdvisoryLevel {
  if (hits.length === 0) {
    return 'none';
  }
  const kinds = new Set(hits.map((hit) => hit.rule));
  if (kinds.has(DIRECTIVE_RULES.toolName) || kinds.size > 1) {
    return 'high';
  }
  return 'elevated';
}

export { advisoryLevel, directiveHits, looksDirective };
