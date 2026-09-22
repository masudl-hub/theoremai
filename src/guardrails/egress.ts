/**
 * Bundled egress policy helpers for hosts that want kernel-default disclosure checks.
 *
 * @module
 */

import type { RedactSpan } from "../observability/spans.ts";
import { scanTextForCanaryLeak } from "./canary.ts";
import { hitFromSpan } from "./hits.ts";
import { injectionSpans } from "./injection.ts";
import { sensitiveSpans } from "./sensitive.ts";
import { textForScan } from "./serialize.ts";
import { SEVERITIES } from "./types.ts";
import type {
  EgressEnforcer,
  GuardrailContext,
  GuardrailHit,
  OutboundPayload,
  Severity,
  Verdict,
} from "./types.ts";

const SYSTEM_BOUNDARY = /This turn's canary is|<\/?user_data>/i; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)

/** Rule ids emitted by the bundled outbound policy. */
export const EGRESS_RULES = {
  canary: "egress.canary-leak",
  sensitive: "egress.sensitive-echo",
  boundary: "egress.system-boundary",
  injection: "egress.injection-echo", // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  /** Payload could not be rendered for inspection — released output is unverified. */
  unscannable: "egress.unscannable", // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  /** The host policy threw instead of returning a verdict. */
  enforcerError: "egress.enforcer-error", // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
function collectEgressHits(text: string, canary?: string): GuardrailHit[] {
  const hits: GuardrailHit[] = [];
  if (canary && scanTextForCanaryLeak(text, canary)) {
    // Never put the live canary token into match — placeholder only.
    hits.push({
      rule: EGRESS_RULES.canary,
      severity: "high",
      match: "[canary]",
    });
  }
  hits.push(
    ...hitsFromSpans(
      text,
      sensitiveSpans(text),
      EGRESS_RULES.sensitive,
      "high",
    ),
  ); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  const boundary = SYSTEM_BOUNDARY.exec(text);
  if (boundary && boundary.index !== undefined) {
    hits.push(
      hitFromSpan(
        text,
        { start: boundary.index, end: boundary.index + boundary[0].length },
        EGRESS_RULES.boundary,
        "medium",
      ),
    );
  }
  hits.push(
    ...hitsFromSpans(
      text,
      injectionSpans(text),
      EGRESS_RULES.injection,
      "medium",
    ),
  ); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  return hits;
}

/** Distinct rule ids in a hit list, in first-seen order — for rejection copy. */
function hitRules(hits: GuardrailHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.rule))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isGuardrailHit(value: unknown): value is GuardrailHit {
  if (
    !isRecord(value) || typeof value.rule !== "string" ||
    !value.rule.trim() || !SEVERITIES.includes(value.severity as Severity)
  ) {
    return false;
  }
  if (value.match !== undefined && typeof value.match !== "string") {
    return false;
  }
  if (value.span !== undefined) {
    if (
      !isRecord(value.span) || typeof value.span.start !== "number" ||
      !Number.isFinite(value.span.start) ||
      typeof value.span.end !== "number" ||
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
    case "allow":
      return true;
    case "redact":
      return typeof value.text === "string" && isGuardrailHits(value.hits);
    case "flag":
      return isGuardrailHits(value.hits);
    case "block":
      return isGuardrailHits(value.hits) &&
        typeof value.rejection === "string" &&
        (value.refusal === undefined || typeof value.refusal === "string");
    default:
      return false;
  }
}

function legacyHits(value: unknown): GuardrailHit[] {
  if (!Array.isArray(value)) {
    return [{ rule: EGRESS_RULES.enforcerError, severity: "high" }];
  }
  const hits = value
    .map((hit): GuardrailHit | undefined => {
      if (typeof hit === "string" && hit.trim()) {
        return { rule: hit, severity: "high" };
      }
      if (isRecord(hit) && typeof hit.rule === "string" && hit.rule.trim()) {
        const severity = SEVERITIES.includes(hit.severity as Severity)
          ? (hit.severity as Severity)
          : "high";
        return { rule: hit.rule, severity };
      }
      return undefined;
    })
    .filter((hit): hit is GuardrailHit => Boolean(hit));
  return hits.length
    ? hits
    : [{ rule: EGRESS_RULES.enforcerError, severity: "high" }];
}

function normalizeVerdict(value: unknown): Verdict {
  if (isVerdict(value)) {
    return value;
  }
  if (isRecord(value) && typeof value.blocked === "boolean") {
    if (!value.blocked) {
      return { action: "allow" };
    }
    const text = typeof value.text === "string" ? value.text : "";
    const rejection = typeof value.rejectionMessage === "string" &&
        value.rejectionMessage.trim()
      ? value.rejectionMessage
      : "Egress blocked";
    return {
      action: "block",
      hits: legacyHits(value.hits),
      rejection,
      ...(text.trim() ? { refusal: text } : {}),
    };
  }
  return {
    action: "block",
    hits: [{ rule: EGRESS_RULES.enforcerError, severity: "high" }],
    rejection: "Egress policy returned an invalid verdict shape",
  };
}

/** Default egress enforce — canary leak, sensitive echo, fence markers, injection echo. */
function standardEgressEnforce(
  payload: OutboundPayload,
  context: GuardrailContext,
): Verdict {
  const hits = collectEgressHits(payload.text, context.canary);
  if (payload.structured !== undefined) {
    const structured = textForScan(payload.structured);
    if (structured.unscannable) {
      // Cannot inspect it, so cannot vouch for it. Fail closed.
      hits.push({ rule: EGRESS_RULES.unscannable, severity: "high" }); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    } else {
      hits.push(...collectEgressHits(structured.text, context.canary));
    }
  }
  if (hits.length === 0) {
    return { action: "allow" };
  }
  return {
    action: "block", // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    hits,
    rejection: `Egress blocked: ${hitRules(hits).join(", ")}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
}

/**
 * Run a host policy without letting it break the turn.
 *
 * A policy that throws has reached no decision, so it cannot vouch for the output:
 * the failure becomes a `block`, not a pass. The turn then follows the profile's
 * ordinary `onBlock` handling instead of surfacing a raw host stack trace.
 */
async function runEnforcer(
  enforce: EgressEnforcer,
  payload: OutboundPayload,
  context: GuardrailContext,
): Promise<Verdict> {
  try {
    return normalizeVerdict(await enforce(payload, context));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      action: "block",
      hits: [{ rule: EGRESS_RULES.enforcerError, severity: "high" }],
      rejection: `Egress policy failed to reach a decision: ${detail}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    };
  }
}

export { collectEgressHits, hitRules, runEnforcer, standardEgressEnforce };
