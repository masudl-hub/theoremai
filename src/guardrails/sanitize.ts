import { sanitizeTurnBlobs } from '../kernel/registry/attachments.ts';
import { mapSystemPrompt } from '../kernel/system-parts.ts';
import type { NormalizedTurnRequest, Profile, TurnEvent, TurnRequest } from '../kernel/types.ts';
import { applySpans } from '../observability/spans.ts';
import { guardrailFromHits } from './events.ts';
import { hitFromSpan } from './hits.ts';
import { injectionSpans } from './injection.ts';
import { type DetectionOptions, detectionForTrust, resolveGuardrailPolicy } from './policy.ts';
import { SANITIZE_RULES } from './rules.ts';
import { anySensitive, resolveSensitive, sensitiveSpans } from './sensitive.ts';
import type { GuardrailHit, GuardrailStage, TrustLevel } from './types.ts';

/** Runs detection over text and returns the cleaned text with the hits. */
function detectText(
  text: string,
  options?: Partial<DetectionOptions>,
): { text: string; hits: GuardrailHit[] } {
  const sanitizeInput = options?.sanitizeInput ?? true;
  const groups = resolveSensitive(options?.redactSensitive);
  if (!sanitizeInput && !anySensitive(groups)) {
    return { text, hits: [] };
  }
  const spans = [...(sanitizeInput ? injectionSpans(text) : []), ...sensitiveSpans(text, groups)];
  const hits: GuardrailHit[] = spans.map((span) =>
    hitFromSpan(
      text,
      span,
      span.kind === 'injection' ? SANITIZE_RULES.injection : SANITIZE_RULES.sensitive,
      'high',
    ),
  );
  return { text: applySpans(text, spans), hits };
}

/** Runs detection over text and returns the cleaned text. */
function sanitizeText(text: string, options?: Partial<DetectionOptions>): string {
  return detectText(text, options).text;
}

/** Redacts sensitive values from text and leaves everything else. */
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

const PROJECT_ID_OK = /^[A-Za-z0-9._-]+$/;

/** The project id trimmed, or `undefined` when it is empty or has illegal characters. */
function sanitizeProjectId(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed && PROJECT_ID_OK.test(trimmed) ? trimmed : undefined;
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

/** The detection options a profile sets for content at this trust level. */
function detectionForProfile(profile: Profile, trust: TrustLevel): DetectionOptions {
  return detectionForTrust(resolveGuardrailPolicy(profile.guardrails), trust);
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
 * `req.system` is host-assembled per turn — it interpolates retrieval and user
 * data, so it is treated as `assembled`, not trusted. `identity.system` never
 * reaches this path and stays verbatim.
 */
function sanitizeTurnRequestText(
  req: TurnRequest,
  profile: Profile,
): { request: NormalizedTurnRequest; events: TurnEvent[] } {
  const untrusted = detectionForProfile(profile, 'untrusted');
  const assembled = detectionForProfile(profile, 'assembled');
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

  const system =
    req.system === undefined
      ? undefined
      : mapSystemPrompt(req.system, 'TurnRequest.system', (part) => {
          const detected = detectText(part, assembled);
          appendHits(systemHits, detected.hits);
          return detected.text;
        });

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

/** The turn request with its input cleaned under the profile's guardrails. */
function sanitizeTurnRequest(req: TurnRequest, profile: Profile): NormalizedTurnRequest {
  return sanitizeTurnRequestWithEvents(req, profile).request;
}

/** Attachments and voice are validated but emit no guardrail events. */
function sanitizeTurnRequestWithEvents(
  req: TurnRequest,
  profile: Profile,
): {
  request: NormalizedTurnRequest;
  events: TurnEvent[];
} {
  const { request: textSafe, events } = sanitizeTurnRequestText(req, profile);
  const input = textSafe.input ?? {};
  const { attachments, voice } =
    input.attachments?.length || input.voice?.length
      ? sanitizeTurnBlobs(profile, input.attachments, input.voice)
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
  redactSensitiveOnly,
  sanitizeHistory,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
  sanitizeTurnRequestWithEvents,
};
