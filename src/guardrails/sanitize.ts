/**
 * Request sanitization utilities for THEORUM.
 *
 * @module
 */

import { sanitizeTurnBlobsForProfile } from '../kernel/registry/attachments.ts';
import { getProfile } from '../kernel/registry/profiles.ts';
import type { NormalizedTurnRequest, TurnRequest } from '../kernel/types.ts';
import { applySpans } from '../observability/spans.ts';
import { injectionSpans } from './injection.ts';
import { sensitiveSpans } from './sensitive.ts';

/** Sanitize one text value using prompt-injection and sensitive-data detectors. */
function sanitizeText(
  text: string,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): string {
  const sanitizeInput = options?.sanitizeInput ?? true;
  const redactSensitive = options?.redactSensitive ?? true;
  if (!sanitizeInput && !redactSensitive) {
    return text;
  }
  const spans = [
    ...(sanitizeInput ? injectionSpans(text) : []),
    ...(redactSensitive ? sensitiveSpans(text) : []),
  ];
  return applySpans(text, spans);
}

/** Redact only sensitive data (credentials, PII) — skip injection patterns. */
function redactSensitiveOnly(text: string): string {
  const spans = sensitiveSpans(text);
  if (spans.length === 0) return text;
  return applySpans(text, spans);
}

function sanitizeSlots(
  slots: Record<string, string> | undefined,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): Record<string, string> | undefined {
  if (!slots) {
    return slots;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(slots)) {
    out[key] = sanitizeText(value, options);
  }
  return out;
}

const PROJECT_ID_MAX = 128;
const PROJECT_ID_OK = /^[A-Za-z0-9._-]+$/;

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
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): import('../kernel/types.ts').TurnRepairRequest | undefined {
  if (!repair) {
    return repair;
  }
  return {
    previousOutput: sanitizeText(repair.previousOutput, options),
    rejection: sanitizeText(repair.rejection, options),
    guidance: repair.guidance ? sanitizeText(repair.guidance, options) : undefined,
  };
}

function sanitizeHistory(
  history: import('../kernel/types.ts').TurnHistoryMessage[] | undefined,
  options?: { sanitizeInput?: boolean; redactSensitive?: boolean },
): import('../kernel/types.ts').TurnHistoryMessage[] | undefined {
  if (!history) {
    return history;
  }
  return history.map((m) => ({
    role: m.role,
    ...(m.content !== undefined ? { content: sanitizeText(m.content, options) } : {}),
    ...(m.parts
      ? {
          parts: m.parts.map((p) =>
            p.type === 'text' ? { ...p, text: sanitizeText(p.text, options) } : p,
          ),
        }
      : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.metadata ? { metadata: m.metadata } : {}),
  }));
}

type GuardrailTextOptions = { sanitizeInput?: boolean; redactSensitive?: boolean };

function guardrailTextOptions(profileId: string): GuardrailTextOptions {
  let profileGuardrails: GuardrailTextOptions | undefined;
  try {
    profileGuardrails = getProfile(profileId)?.guardrails;
  } catch {
    // If profile not registered yet, default to full guardrails.
  }
  return {
    sanitizeInput: profileGuardrails?.sanitizeInput ?? true,
    redactSensitive: profileGuardrails?.redactSensitive ?? true,
  };
}

/** Sanitize user-controlled text fields; leave attachments/voice untouched. */
function sanitizeTurnRequestText(
  req: TurnRequest,
  options: GuardrailTextOptions,
): NormalizedTurnRequest {
  const input = req.input ?? {};
  const { text: rawText } = input;
  let text = rawText;
  if (rawText !== undefined) {
    text = sanitizeText(rawText, options);
  }
  let system = req.system;
  if (system !== undefined) {
    system = sanitizeText(system, options);
  }
  return {
    ...req,
    system,
    projectId: sanitizeProjectId(req.projectId),
    input: {
      ...input,
      text,
      slots: sanitizeSlots(input.slots, options),
      repair: sanitizeRepair(input.repair, options),
      history: sanitizeHistory(input.history, options),
    },
  };
}

/** Sanitize all user-controlled text and blobs in a turn request. */
function sanitizeTurnRequest(req: TurnRequest): NormalizedTurnRequest {
  const options = guardrailTextOptions(req.profile);
  const textSafe = sanitizeTurnRequestText(req, options);
  const input = textSafe.input ?? {};
  const { attachments, voice } = sanitizeTurnBlobsForProfile(
    req.profile,
    input.attachments,
    input.voice,
  );
  return {
    ...textSafe,
    input: {
      ...input,
      attachments,
      voice,
    },
  };
}

/**
 * Trace-safe request sanitize. Prefers full `sanitizeTurnRequest`; if blob/policy
 * checks throw, still redacts text and keeps attachments for hashing — never invents empty input.
 */
function sanitizeTurnRequestForTrace(req: TurnRequest): {
  request: NormalizedTurnRequest;
  sanitizeError?: string;
} {
  try {
    return { request: sanitizeTurnRequest(req) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      request: sanitizeTurnRequestText(req, guardrailTextOptions(req.profile)),
      sanitizeError: message,
    };
  }
}

export {
  PROJECT_ID_MAX,
  redactSensitiveOnly,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
  sanitizeTurnRequestForTrace,
};
