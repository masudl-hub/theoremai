import { sanitizeTurnBlobs } from '../kernel/registry/attachments.ts';
import { CONTEXT_SENDERS, type ContextSender } from '../kernel/schema.ts';
import { mapSystemPrompt } from '../kernel/system-parts.ts';
import type {
  NormalizedTurnRequest,
  Profile,
  TurnContext,
  TurnEvent,
  TurnHistoryMessage,
  TurnRepairRequest,
  TurnRequest,
} from '../kernel/types.ts';
import { type Boundary, recordOf } from './boundaries.ts';
import { type BoundaryReader, boundaryReader, detectEvent } from './detect-at.ts';
import { guardrailTurnEvent } from './events.ts';
import { resolveGuardrailPolicy } from './policy.ts';
import { TheoremError } from './theorem-error.ts';
import type { GuardrailEvent, TrustLevel } from './types.ts';

/** The boundaries one turn request crosses, in the order their events are reported. */
const REQUEST_BOUNDARIES = [
  'user',
  'slots',
  'repair',
  'attachment',
  'voice',
  'history',
  'system',
] as const satisfies readonly Boundary[];

function sanitizeSlots(
  slots: Record<string, string> | undefined,
  reader: BoundaryReader,
): Record<string, string> | undefined {
  if (!slots) {
    return slots;
  }
  return Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, reader.read(value)]));
}

/** The browser's context is the visitor's to change; the host's is built by its own code, like turn system text. */
const CONTEXT_TRUST: Readonly<Record<ContextSender, TrustLevel>> = {
  client: 'untrusted',
  server: 'assembled',
};

/** A context package as the model reads it: text as written, anything else as JSON. */
function contextText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Each sender's package read at the `context` boundary, with what was found there. */
function sanitizeContext(
  context: TurnContext | undefined,
  readerFor: () => BoundaryReader,
): { context: TurnContext | undefined; events: GuardrailEvent[]; blocked: boolean } {
  const events: GuardrailEvent[] = [];
  let blocked = false;
  if (!context) return { context, events, blocked };
  const read: TurnContext = {};
  for (const sender of CONTEXT_SENDERS) {
    const value = context[sender];
    if (value === undefined) continue;
    const reader = readerFor();
    read[sender] = reader.read(contextText(value));
    const found = reader.found();
    const event = detectEvent('context', found);
    if (event) events.push({ ...event, trust: CONTEXT_TRUST[sender] });
    blocked ||= found.action === 'block';
  }
  return { context: read, events, blocked };
}

const PROJECT_ID_OK = /^[A-Za-z0-9._-]+$/;

/** The project id trimmed, or `undefined` when it is empty or has illegal characters. */
function sanitizeProjectId(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed && PROJECT_ID_OK.test(trimmed) ? trimmed : undefined;
}

function sanitizeRepair(
  repair: TurnRepairRequest | undefined,
  reader: BoundaryReader,
): TurnRepairRequest | undefined {
  if (!repair) {
    return repair;
  }
  const guidance = repair.guidance ? reader.read(repair.guidance) : undefined;
  return {
    previousOutput: reader.read(repair.previousOutput),
    rejection: reader.read(repair.rejection),
    ...(guidance ? { guidance } : {}),
  };
}

/**
 * Exported because every path that injects messages into a turn needs it — turn
 * history, and host steer injects mid-turn. A second copy would drift.
 */
function sanitizeHistory(
  history: TurnHistoryMessage[],
  reader: BoundaryReader,
): TurnHistoryMessage[] {
  return history.map((m) => {
    const content = m.content === undefined ? undefined : reader.read(m.content);
    const parts = m.parts?.map((p) =>
      p.type === 'text' ? { ...p, text: reader.read(p.text) } : p,
    );
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

/** The error a turn ends on when a detector set to `block` matched at `boundary`. */
function requestRefused(boundary: Boundary): TheoremError {
  // lexicon-exempt: developer contract / internal diagnostic — the user's wording is `detect.blocked`
  return new TheoremError('input', `guardrails.detect blocked the request at ${boundary}`, {
    copy: { key: 'detect.blocked' },
  });
}

/** A turn request read at each boundary it crosses. */
interface SanitizedTurnRequest {
  request: NormalizedTurnRequest;
  /** One guardrail event for each boundary where something matched. */
  events: TurnEvent[];
  /** Set when a match blocks: the request does not reach the model, and the turn ends on this. */
  refusal?: TheoremError;
}

/**
 * `req.system` is host-assembled per turn — it interpolates retrieval and user
 * data, so it is read at its own boundary. `identity.system` never reaches this
 * path and stays verbatim.
 */
function sanitizeTurnRequestWithEvents(req: TurnRequest, profile: Profile): SanitizedTurnRequest {
  const { detect } = resolveGuardrailPolicy(profile.guardrails);
  const at = recordOf(REQUEST_BOUNDARIES, (boundary) => boundaryReader(boundary, detect));
  const input = req.input ?? {};

  const text = input.text === undefined ? undefined : at.user.read(input.text);
  const system =
    req.system === undefined
      ? undefined
      : mapSystemPrompt(req.system, 'TurnRequest.system', (part) => at.system.read(part));
  const slots = sanitizeSlots(input.slots, at.slots);
  const told = sanitizeContext(input.context, () => boundaryReader('context', detect));
  const repair = sanitizeRepair(input.repair, at.repair);
  const history = input.history ? sanitizeHistory(input.history, at.history) : undefined;
  const { attachments, voice } =
    input.attachments?.length || input.voice?.length
      ? sanitizeTurnBlobs(profile, input.attachments, input.voice, at)
      : input;

  const events: TurnEvent[] = [];
  let refusal: TheoremError | undefined;
  for (const boundary of REQUEST_BOUNDARIES) {
    const found = at[boundary].found();
    const event = detectEvent(boundary, found);
    if (event) events.push(guardrailTurnEvent(event));
    if (found.action === 'block') refusal ??= requestRefused(boundary);
  }
  events.push(...told.events.map(guardrailTurnEvent));
  if (told.blocked) refusal ??= requestRefused('context');

  return {
    request: {
      ...req,
      system,
      projectId: sanitizeProjectId(req.projectId),
      input: {
        ...input,
        text,
        slots,
        ...(told.context ? { context: told.context } : {}),
        repair,
        history,
        attachments,
        voice,
      },
    },
    events,
    ...(refusal ? { refusal } : {}),
  };
}

/** The turn request with its input cleaned under the profile's guardrails. Throws when a match blocks it. */
function sanitizeTurnRequest(req: TurnRequest, profile: Profile): NormalizedTurnRequest {
  const { request, refusal } = sanitizeTurnRequestWithEvents(req, profile);
  if (refusal) throw refusal;
  return request;
}

export type { SanitizedTurnRequest };
export {
  contextText,
  requestRefused,
  sanitizeContext,
  sanitizeHistory,
  sanitizeProjectId,
  sanitizeTurnRequest,
  sanitizeTurnRequestWithEvents,
};
