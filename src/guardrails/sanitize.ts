/**
 * Request sanitization utilities for THEOREM.
 *
 * @module
 */

import { sanitizeTurnBlobs } from '../kernel/registry/attachments.ts';
import { getProfile } from '../kernel/registry/profiles.ts';
import type { NormalizedTurnRequest, TurnEvent, TurnRequest } from '../kernel/types.ts';
import { applySpans } from '../observability/spans.ts';
import { guardrailFromHits } from './events.ts';
import { hitFromSpan } from './hits.ts';
import { injectionSpans } from './injection.ts';
import { type DetectionOptions, detectionForTrust, resolveGuardrailPolicy } from './policy.ts';
import { sensitiveSpans } from './sensitive.ts';
import type { GuardrailHit, GuardrailStage, TrustLevel } from './types.ts';

/**
 * Detect and redact injection / sensitive spans. Returns hits for observability
 * (rule + offsets + optional `match` preview for debugging).
 */
function detectText(
  text: string,
  options?: Partial<DetectionOptions>,
): { text: string; hits: GuardrailHit[] } {
  const sanitizeInput = options?.sanitizeInput ?? true;
  const redactSensitive = options?.redactSensitive ?? true;
  if (!sanitizeInput && !redactSensitive) {
    return { text, hits: [] };
  }
  const spans = [
    ...(sanitizeInput ? injectionSpans(text) : []),
    ...(redactSensitive ? sensitiveSpans(text) : []),
  ];
  const hits: GuardrailHit[] = spans.map((span) =>
    hitFromSpan(
      text,
      span,
      span.kind === 'injection' ? 'sanitize.injection' : 'sanitize.sensitive',
      'high',
    ),
  );
  return { text: applySpans(text, spans), hits };
}

/** Sanitize one text value using prompt-injection and sensitive-data detectors. */
function sanitizeText(text: string, options?: Partial<DetectionOptions>): string {
  return detectText(text, options).text;
}

/** Redact only sensitive data (credentials, PII) — skip injection patterns. */
function redactSensitiveOnly(text: string): string {
  return detectText(text, { sanitizeInput: false, redactSensitive: true }).text;
}

function appendHits(into: GuardrailHit[], hits: GuardrailHit[]): void {
  for (const hit of hits) {
    into.push(hit);
  }
}

function sanitizeSlots(
  slots: Record<string, string> | undefined,
  options: DetectionOptions,
  hits: GuardrailHit[],
): Record<string, string> | undefined {
  if (!slots) {
    return slots;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(slots)) {
    const detected = detectText(value, options);
    appendHits(hits, detected.hits);
    out[key] = detected.text;
  }
  return out;
}

/** Maximum length retained for a sanitized host project identifier. */
const PROJECT_ID_MAX = 128;
const PROJECT_ID_OK = /^[A-Za-z0-9._-]+$/;

/** Trims and validates a project identifier, returning undefined for invalid input. */
function sanitizeProjectId(id: string | undefined): string | undefined {
  if (!id) {
    return undefined;
  }
  const trimmed = id.trim().slice(0, PROJECT_ID_MAX);
  if (!PROJECT_ID_OK.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function sanitizeRepair(
  repair: import('../kernel/types.ts').TurnRepairRequest | undefined,
  options: DetectionOptions,
  hits: GuardrailHit[],
): import('../kernel/types.ts').TurnRepairRequest | undefined {
  if (!repair) {
    return repair;
  }
  const previous = detectText(repair.previousOutput, options);
  const rejection = detectText(repair.rejection, options);
  appendHits(hits, previous.hits);
  appendHits(hits, rejection.hits);
  let guidance = repair.guidance;
  if (guidance) {
    const detected = detectText(guidance, options);
    appendHits(hits, detected.hits);
    guidance = detected.text;
  }
  return {
    previousOutput: previous.text,
    rejection: rejection.text,
    ...(guidance ? { guidance } : {}),
  };
}

/**
 * Sanitize the text of each history message; tool calls, ids, and metadata pass
 * through untouched.
 *
 * Exported because every path that injects messages into a turn needs it — turn
 * history, and host steer injects mid-turn. A second copy would drift.
 */
function sanitizeHistory(
  history: import('../kernel/types.ts').TurnHistoryMessage[],
  options: DetectionOptions,
  hits: GuardrailHit[] = [],
): import('../kernel/types.ts').TurnHistoryMessage[] {
  return history.map((m) => {
    let content = m.content;
    if (content !== undefined) {
      const detected = detectText(content, options);
      appendHits(hits, detected.hits);
      content = detected.text;
    }
    let parts = m.parts;
    if (parts) {
      parts = parts.map((p) => {
        if (p.type !== 'text') {
          return p;
        }
        const detected = detectText(p.text, options);
        appendHits(hits, detected.hits);
        return { ...p, text: detected.text };
      });
    }
    return {
      role: m.role,
      ...(content !== undefined ? { content } : {}),
      ...(parts ? { parts } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
      ...(m.metadata ? { metadata: m.metadata } : {}),
    };
  });
}

/**
 * Detection switches for one profile at one trust level.
 *
 * Falls back to full detection when the profile is not registered yet, so an
 * unknown id never silently disables guardrails.
 */
function detectionForProfile(profileId: string, trust: TrustLevel): DetectionOptions {
  let spec: import('./types.ts').ProfileGuardrailsSpec | undefined;
  try {
    spec = getProfile(profileId)?.guardrails;
  } catch {
    // If profile not registered yet, default to full guardrails.
  }
  return detectionForTrust(resolveGuardrailPolicy(spec), trust);
}

function pushStageEvent(
  events: TurnEvent[],
  stage: GuardrailStage,
  trust: TrustLevel,
  hits: GuardrailHit[],
): void {
  const event = guardrailFromHits(stage, trust, hits, 'redact');
  if (event) {
    events.push(event);
  }
}

/**
 * Sanitize user-controlled text fields; leave attachments/voice untouched.
 *
 * Returns `{ type: 'guardrail' }` events for stages that redacted something.
 * Clean surfaces emit nothing.
 *
 * `req.system` is host-assembled per turn — it interpolates retrieval and user
 * data, so it is treated as `assembled`, not trusted. `identity.system` never
 * reaches this path and stays verbatim.
 */
function sanitizeTurnRequestText(
  req: TurnRequest,
  profileId: string,
): { request: NormalizedTurnRequest; events: TurnEvent[] } {
  const untrusted = detectionForProfile(profileId, 'untrusted');
  const assembled = detectionForProfile(profileId, 'assembled');
  const input = req.input ?? {};
  const events: TurnEvent[] = [];
  const inputHits: GuardrailHit[] = [];
  const historyHits: GuardrailHit[] = [];
  const systemHits: GuardrailHit[] = [];

  const { text: rawText } = input;
  let text = rawText;
  if (rawText !== undefined) {
    const detected = detectText(rawText, untrusted);
    appendHits(inputHits, detected.hits);
    text = detected.text;
  }

  let system = req.system;
  if (system !== undefined) {
    const detected = detectText(system, assembled);
    appendHits(systemHits, detected.hits);
    system = detected.text;
  }

  const slots = sanitizeSlots(input.slots, untrusted, inputHits);
  const repair = sanitizeRepair(input.repair, untrusted, inputHits);
  const history = input.history
    ? sanitizeHistory(input.history, untrusted, historyHits)
    : undefined;

  pushStageEvent(events, 'input', 'untrusted', inputHits);
  pushStageEvent(events, 'history', 'untrusted', historyHits);
  pushStageEvent(events, 'system', 'assembled', systemHits);

  return {
    request: {
      ...req,
      system,
      projectId: sanitizeProjectId(req.projectId),
      input: {
        ...input,
        text,
        slots,
        repair,
        history,
      },
    },
    events,
  };
}

/** Sanitize all user-controlled text and blobs in a turn request. */
function sanitizeTurnRequest(req: TurnRequest): NormalizedTurnRequest {
  return sanitizeTurnRequestWithEvents(req).request;
}

/**
 * Sanitize a turn request and return guardrail events for any redactionsactions spans.
 * Attachments/voice are validated but do not emit content-span events.
 */
function sanitizeTurnRequestWithEvents(req: TurnRequest): {
  request: NormalizedTurnRequest;
  events: TurnEvent[];
} {
  const { request: textSafe, events } = sanitizeTurnRequestText(req, req.profile);
  const input = textSafe.input ?? {};
  const { attachments, voice } =
    input.attachments?.length || input.voice?.length
      ? sanitizeTurnBlobs(getProfile(req.profile), input.attachments, input.voice)
      : input;
  return {
    request: {
      ...textSafe,
      input: {
        ...input,
        attachments,
        voice,
      },
    },
    events,
  };
}

export {
  detectionForProfile,
  detectText,
  PROJECT_ID_MAX,
  redactSensitiveOnly,
  sanitizeHistory,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
  sanitizeTurnRequestWithEvents,
};
