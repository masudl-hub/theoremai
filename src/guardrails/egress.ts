/**
 * Bundled egress policy helpers for hosts that want kernel-default disclosure checks.
 *
 * @module
 */

import type { TurnEvent } from '../kernel/types.ts';
import { isRecord } from '../kernel/util/record.ts';
import type { RedactSpan } from '../observability/spans.ts';
import { guardedEventTexts, scanTextForCanaryLeak } from './canary.ts';
import { describeError } from './error.ts';
import { hitFromSpan } from './hits.ts';
import { injectionSpans } from './injection.ts';
import { lexiconText } from './lexicon.ts';
import { scanTextForPromptEcho } from './prompt-echo.ts';
import { sensitiveSpans } from './sensitive.ts';
import { textForScan } from './serialize.ts';
import type {
  EgressEnforcer,
  GuardrailContext,
  GuardrailHit,
  OutboundPayload,
  Severity,
  Verdict,
} from './types.ts';
import { SEVERITIES } from './types.ts';

const SYSTEM_BOUNDARY = /This turn\x27s canary is|<\/?user_data>/i; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)

/** Rule ids emitted by the bundled outbound policy. */
export const EGRESS_RULES = {
  canary: 'egress.canary-leak',
  /** The reply repeats the system prompt (`guardrails.promptEcho`). */
  promptEcho: 'egress.prompt-echo', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  /**
   * A provider-side built-in tool (URL context, search, code execution) carried
   * the canary or the system prompt. It ran at the provider before Theorem saw
   * it: the data already left, so this is an incident, not a prevented leak.
   */
  providerToolLeak: 'egress.provider-tool-leak', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  sensitive: 'egress.sensitive-echo',
  boundary: 'egress.system-boundary',
  injection: 'egress.injection-echo', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  /** Payload could not be rendered for inspection — released output is unverified. */
  unscannable: 'egress.unscannable', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  /** The host policy threw instead of returning a verdict. */
  enforcerError: 'egress.enforcer-error', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
} as const;

function hitsFromSpans(
  text: string,
  spans: RedactSpan[],
  rule: string,
  severity: Severity,
): GuardrailHit[] {
  return spans.map((span) => hitFromSpan(text, span, rule, severity));
}

/** Hits from the bundled outbound policy (canary / sensitive / boundary / injection). */
/** A canary leak. Never carries the live token — placeholder only. */
/** Why a reply was withheld, for the builder (`errorInternal`); the user reads `error.safety`. */
const WITHHELD_REASON = {
  canary: 'canary leaked',
  promptEcho: 'system prompt echoed', // lexicon-exempt: internal diagnostic — the user reads error.safety
  providerToolLeak: 'a provider-side tool already sent the canary or system prompt', // lexicon-exempt: internal diagnostic — the user reads error.safety
  egress: 'Turn withheld: egress disclosure violation', // lexicon-exempt: internal diagnostic — the user reads error.safety
} as const;

const CANARY_HIT: GuardrailHit = { rule: EGRESS_RULES.canary, severity: 'high', match: '[canary]' };

const PROMPT_ECHO_HIT: GuardrailHit = { rule: EGRESS_RULES.promptEcho, severity: 'high' };

/** The canary hit, when `text` leaks it. */
function canaryHits(text: string, canary?: string): GuardrailHit[] {
  return canary && scanTextForCanaryLeak(text, canary) ? [CANARY_HIT] : [];
}

/** The system-prompt leak hits: the canary, and the prompt's own words when guarded. */
function promptLeakHits(text: string, canary?: string, system?: string): GuardrailHit[] {
  const hits = canaryHits(text, canary);
  if (system && scanTextForPromptEcho(text, system)) {
    hits.push(PROMPT_ECHO_HIT);
  }
  return hits;
}

const PROVIDER_TOOL_LEAK_HIT: GuardrailHit = {
  rule: EGRESS_RULES.providerToolLeak,
  severity: 'high',
};

const PROVIDER_TOOL_KINDS = /^(?:google_|url_context|code_execution)/;

/**
 * The provider's report of a built-in tool it already ran: grounding, and the
 * URL-context, search, and code-execution steps. What it carries has left.
 */
function isProviderToolReport(event: TurnEvent): boolean {
  return (
    event.type === 'grounding' ||
    (event.type === 'evidence' && PROVIDER_TOOL_KINDS.test(event.evidence?.kind ?? ''))
  );
}

/**
 * The system-prompt leak hits in any content-bearing field of an event
 * (`guardedEventTexts`). In the report of a provider-side tool they are one
 * `egress.provider-tool-leak`: the call already ran.
 */
function eventPromptLeakHits(event: TurnEvent, canary?: string, system?: string): GuardrailHit[] {
  const hits = guardedEventTexts(event).flatMap((text) => promptLeakHits(text, canary, system));
  if (hits.length > 0 && isProviderToolReport(event)) {
    return [PROVIDER_TOOL_LEAK_HIT];
  }
  return [...new Map(hits.map((hit) => [hit.rule, hit])).values()];
}

const PROMPT_LEAK_RULES = new Set<string>([
  EGRESS_RULES.canary,
  EGRESS_RULES.promptEcho,
  EGRESS_RULES.providerToolLeak,
]);

/** Whether a hit is a system-prompt leak: a hard stop under any host policy. */
function isPromptLeakHit(hit: GuardrailHit): boolean {
  return PROMPT_LEAK_RULES.has(hit.rule);
}

/** Why a system-prompt leak withheld the reply, for the builder. */
function promptLeakReason(hits: GuardrailHit[]): string {
  if (hits.some((hit) => hit.rule === EGRESS_RULES.providerToolLeak)) {
    return WITHHELD_REASON.providerToolLeak;
  }
  return hits.some((hit) => hit.rule === EGRESS_RULES.canary)
    ? WITHHELD_REASON.canary
    : WITHHELD_REASON.promptEcho;
}

function collectEgressHits(text: string, canary?: string, system?: string): GuardrailHit[] {
  const hits = promptLeakHits(text, canary, system);
  hits.push(...hitsFromSpans(text, sensitiveSpans(text), EGRESS_RULES.sensitive, 'high')); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  const boundary = SYSTEM_BOUNDARY.exec(text);
  if (boundary && boundary.index !== undefined) {
    hits.push(
      hitFromSpan(
        text,
        { start: boundary.index, end: boundary.index + boundary[0].length },
        EGRESS_RULES.boundary,
        'medium',
      ),
    );
  }
  hits.push(...hitsFromSpans(text, injectionSpans(text), EGRESS_RULES.injection, 'medium')); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  return hits;
}

/** Distinct rule ids in a hit list, in first-seen order — for rejection copy. */
function hitRules(hits: GuardrailHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.rule))];
}

function isGuardrailHit(value: unknown): value is GuardrailHit {
  if (
    !isRecord(value) ||
    typeof value.rule !== 'string' ||
    !value.rule.trim() ||
    !SEVERITIES.includes(value.severity as Severity)
  ) {
    return false;
  }
  if (value.match !== undefined && typeof value.match !== 'string') {
    return false;
  }
  if (value.span !== undefined) {
    if (
      !isRecord(value.span) ||
      typeof value.span.start !== 'number' ||
      !Number.isFinite(value.span.start) ||
      typeof value.span.end !== 'number' ||
      !Number.isFinite(value.span.end)
    ) {
      return false;
    }
  }
  return true;
}

function isGuardrailHits(value: unknown): value is GuardrailHit[] {
  return Array.isArray(value) && value.every(isGuardrailHit);
}

function isVerdict(value: unknown): value is Verdict {
  if (!isRecord(value)) return false;
  switch (value.action) {
    case 'allow':
      return true;
    case 'redact':
      return typeof value.text === 'string' && isGuardrailHits(value.hits);
    case 'flag':
      return isGuardrailHits(value.hits);
    case 'block':
      return (
        isGuardrailHits(value.hits) &&
        typeof value.rejection === 'string' &&
        (value.errorInternal === undefined || typeof value.errorInternal === 'string')
      );
    default:
      return false;
  }
}

function legacyHits(value: unknown): GuardrailHit[] {
  if (!Array.isArray(value)) {
    return [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }];
  }
  const hits = value
    .map((hit): GuardrailHit | undefined => {
      if (typeof hit === 'string' && hit.trim()) {
        return { rule: hit, severity: 'high' };
      }
      if (isRecord(hit) && typeof hit.rule === 'string' && hit.rule.trim()) {
        const severity = SEVERITIES.includes(hit.severity as Severity)
          ? (hit.severity as Severity)
          : 'high';
        return { rule: hit.rule, severity };
      }
      return undefined;
    })
    .filter((hit): hit is GuardrailHit => Boolean(hit));
  return hits.length ? hits : [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }];
}

function normalizeVerdict(value: unknown, context: GuardrailContext): Verdict {
  if (isVerdict(value)) {
    return value;
  }
  if (isRecord(value) && typeof value.blocked === 'boolean') {
    if (!value.blocked) {
      return { action: 'allow' };
    }
    const hits = legacyHits(value.hits);
    const rejection =
      typeof value.rejectionMessage === 'string' && value.rejectionMessage.trim()
        ? value.rejectionMessage
        : lexiconText('egress.rejection', { rules: hitRules(hits).join(', ') }, context.lexicon);
    return { action: 'block', hits, rejection };
  }
  return {
    action: 'block',
    hits: [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }],
    rejection: lexiconText('egress.invalid_verdict', {}, context.lexicon),
  };
}

/** Default egress enforce — canary leak, sensitive echo, fence markers, injection echo. */
function standardEgressEnforce(payload: OutboundPayload, context: GuardrailContext): Verdict {
  const hits = collectEgressHits(payload.text, context.canary, context.system);
  if (payload.structured !== undefined) {
    const structured = textForScan(payload.structured);
    if (structured.unscannable) {
      // Cannot inspect it, so cannot vouch for it. Fail closed.
      hits.push({ rule: EGRESS_RULES.unscannable, severity: 'high' }); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    } else {
      hits.push(...collectEgressHits(structured.text, context.canary, context.system));
    }
  }
  if (hits.length === 0) {
    return { action: 'allow' };
  }
  return {
    action: 'block',
    hits,
    rejection: lexiconText(
      'egress.rejection',
      { rules: hitRules(hits).join(', ') },
      context.lexicon,
    ),
  };
}

/**
 * Run a host policy without letting it break the turn.
 *
 * A policy that throws has reached no decision, so it cannot vouch for the output:
 * the failure becomes a `block`, not a pass. The turn then follows the profile's
 * ordinary `onBlock` handling instead of surfacing a raw host stack trace. The
 * thrown message may carry host internals, so it goes to the builder only
 * (`errorInternal`); the model reads the lexicon's `egress.policy_failed`.
 */
async function runEnforcer(
  enforce: EgressEnforcer,
  payload: OutboundPayload,
  context: GuardrailContext,
): Promise<Verdict> {
  try {
    return normalizeVerdict(await enforce(payload, context), context);
  } catch (err) {
    return {
      action: 'block',
      hits: [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }],
      rejection: lexiconText('egress.policy_failed', {}, context.lexicon),
      errorInternal: describeError(err),
    };
  }
}

export {
  CANARY_HIT,
  collectEgressHits,
  eventPromptLeakHits,
  hitRules,
  isPromptLeakHit,
  promptLeakHits,
  promptLeakReason,
  runEnforcer,
  standardEgressEnforce,
  WITHHELD_REASON,
};
