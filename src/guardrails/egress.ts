import { isRecord } from '../kernel/util/record.ts';
import type { RedactSpan } from '../observability/spans.ts';
import { scanTextForCanaryLeak } from './canary.ts';
import { describeError } from './error.ts';
import { hitFromSpan } from './hits.ts';
import { injectionSpans } from './injection.ts';
import { lexiconText } from './lexicon.ts';
import { EGRESS_RULES } from './rules.ts';
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

function hitsFromSpans(
  text: string,
  spans: RedactSpan[],
  rule: string,
  severity: Severity,
): GuardrailHit[] {
  return spans.map((span) => hitFromSpan(text, span, rule, severity));
}

/** Why a reply was withheld, for the builder (`errorInternal`); the user reads `error.safety`. */
const WITHHELD_REASON = {
  canary: 'canary leaked',
  egress: 'Turn withheld: egress disclosure violation', // lexicon-exempt: internal diagnostic — the user reads error.safety
} as const;

/** Never carries the live token, only a placeholder. */
const CANARY_HIT: GuardrailHit = { rule: EGRESS_RULES.canary, severity: 'high', match: '[canary]' };

function canaryHits(text: string, canary?: string): GuardrailHit[] {
  return canary && scanTextForCanaryLeak(text, canary) ? [CANARY_HIT] : [];
}

function collectEgressHits(text: string, canary?: string): GuardrailHit[] {
  const hits = canaryHits(text, canary);
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
  for (const key of ['match', 'label', 'doc'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
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
        return {
          rule: hit.rule,
          severity,
          ...(typeof hit.label === 'string' ? { label: hit.label } : {}),
          ...(typeof hit.doc === 'string' ? { doc: hit.doc } : {}),
        };
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
  const hits = collectEgressHits(payload.text, context.canary);
  if (payload.structured !== undefined) {
    const structured = textForScan(payload.structured);
    if (structured.unscannable) {
      // Cannot inspect it, so cannot vouch for it. Fail closed.
      hits.push({ rule: EGRESS_RULES.unscannable, severity: 'high' }); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    } else {
      hits.push(...collectEgressHits(structured.text, context.canary));
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
  canaryHits,
  collectEgressHits,
  hitRules,
  runEnforcer,
  standardEgressEnforce,
  WITHHELD_REASON,
};
