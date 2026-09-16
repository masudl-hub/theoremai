/**
 * Trace record construction types.
 *
 * Trace records preserve useful execution evidence while hashing or omitting
 * unsafe media bytes and canary-sensitive content.
 *
 * @module
 */

import { OMIT_CANARY } from '../guardrails/canary.ts';
import { isAbortError, publicError } from '../guardrails/error.ts';
import { projectGuardrailEvent } from '../guardrails/hits.ts';
import {
  redactSensitiveOnly,
  sanitizeText,
  sanitizeTurnRequestForTrace,
} from '../guardrails/sanitize.ts';
import { sha256 } from '../kernel/engine/hash.ts';
import type { Protocol } from '../kernel/schema.ts';
import type {
  ResolvedGeneration,
  TurnBlob,
  TurnEvent,
  TurnMediaRef,
  TurnRequest,
} from '../kernel/types.ts';
import { resolveObservabilityPolicy } from './resolve-policy.ts';
import { attachResolved, attachTape, attachUsage } from './trace-attach.ts';
import { completedInteraction, stopKindFromEvents } from './trace-usage.ts';
import type {
  ProfileObservabilitySpec,
  ResolvedObservabilityPolicy,
  ResolvedTraceInclude,
  ResolvedTraceScrub,
} from './types.ts';

const TRACE_VERSION = 2;
const TITLE_MAX = 80;

/** Hash-only image reference stored in trace records. */
export interface TraceImage {
  mimeType: string;
  /** Content hash for inline bytes; absent for a provider file reference. */
  sha256?: string;
  /** Provider file reference when the attachment was supplied by uri. */
  uri?: string;
}

/** Trace-safe copy of a public turn event. */
export interface TraceEvent {
  type: string;
  text?: string;
  tool?: {
    name: string;
    arguments?: Record<string, unknown>;
    result?: { status: string; finding?: string; data?: Record<string, unknown> };
  };
  structured?: unknown;
  media?: TraceImage;
  grounding?: TurnEvent['grounding'];
  evidence?: TurnEvent['evidence'];
  /** Guardrail decision — rule identity and offsets, never matched content. */
  guardrail?: TurnEvent['guardrail'];
  error?: string;
  errorInternal?: string;
}

/** Complete trace-safe record for one attempted turn. */
interface TraceRecord {
  v: number;
  id: string;
  ts: number;
  ms: number;
  streamed: boolean;
  cancelled: boolean;
  previousInteractionId: string | null;
  store: boolean | null;
  profile: string;
  title?: string;
  projectId?: string;
  modelSelect?: string;
  effort?: string;
  metadata?: Record<string, unknown>;
  model?: { id: string; apiId: string };
  keySlot?: string;
  generation?: {
    thinking?: string;
    summaries?: string;
    temperature?: number;
    maxOutputTokens?: number;
    builtins: string[];
    visibleTools: string[];
    structured: string | null;
    image: unknown;
  };
  input: {
    text?: string;
    role?: string;
    slots?: Record<string, string>;
    attachments: TraceImage[];
    voice: TraceImage[];
    images?: TraceImage[];
    audio?: TraceImage[];
  };
  wire?: unknown;
  events: TraceEvent[];
  /** Raw upstream tap rows (HTTP, SSE, provider events). */
  upstreamLog?: unknown;
  usage?: unknown;
  upstream?: {
    status?: unknown;
    id?: unknown;
    finish?: unknown;
    serviceTier?: unknown;
  };
  ok: boolean;
  error?: string;
  errorInternal?: string;
  app?: Record<string, unknown>;
  cutout?: {
    ok: boolean;
    ms: number;
    url?: string;
    inSha256?: string;
    outSha256?: string;
    http?: unknown;
    error?: string;
  };
}

function hashBlobs(blobs: Array<TurnBlob | TurnMediaRef> | undefined): Promise<TraceImage[]> {
  if (!blobs) {
    return Promise.resolve([]);
  }
  return Promise.all(
    blobs.map(async (blob) =>
      'uri' in blob
        ? { mimeType: blob.mimeType, uri: blob.uri }
        : { mimeType: blob.mimeType, sha256: await sha256(blob.data) },
    ),
  );
}

function scrubStoredText(text: string, scrub: ResolvedTraceScrub): string {
  if (scrub.sensitive && scrub.injection) {
    return sanitizeText(text);
  }
  if (scrub.sensitive) {
    return redactSensitiveOnly(text);
  }
  if (scrub.injection) {
    return sanitizeText(text, { sanitizeInput: true, redactSensitive: false });
  }
  return text;
}

async function snapshotEvent(
  event: TurnEvent,
  include: ResolvedTraceInclude,
  scrub: ResolvedTraceScrub,
): Promise<TraceEvent> {
  const row: TraceEvent = { type: event.type };
  if (event.text) {
    row.text = scrubStoredText(event.text, scrub);
  }
  if (event.error) {
    row.error = event.error;
  }
  if (event.errorInternal) {
    row.errorInternal = scrubStoredText(event.errorInternal, scrub);
  }
  if (event.structured !== undefined) {
    row.structured = event.structured;
  }
  if (event.tool) {
    const { name, arguments: args, output, phase, failure } = event.tool;
    row.tool = { name, arguments: args };
    if (output !== undefined && phase === 'complete') {
      const data =
        typeof output === 'object' && output !== null
          ? (output as Record<string, unknown>)
          : { value: output };
      row.tool.result = {
        status: 'ok',
        ...(typeof data.finding === 'string' ? { finding: data.finding } : {}),
        data,
      };
    } else if (phase === 'error' && failure) {
      row.tool.result = {
        status: 'error',
        finding: failure.message,
      };
    }
  }
  if (event.media) {
    row.media = {
      mimeType: event.media.mimeType,
      sha256: await sha256(event.media.data),
    };
  }
  if (event.grounding) {
    row.grounding = event.grounding;
  }
  if (include.evidenceRaw && event.evidence) {
    row.evidence = event.evidence;
  }
  if (event.guardrail) {
    row.guardrail = projectGuardrailEvent(event.guardrail, include.guardrailMatchPreview);
  }
  return row;
}

function requestForTrace(req: TurnRequest): {
  request: TurnRequest;
  sanitizeError?: string;
} {
  return sanitizeTurnRequestForTrace(req);
}

function internalError(err: unknown): string | undefined {
  if (typeof err === 'string') {
    return sanitizeText(err);
  }
  if (err instanceof Error && err.message) {
    return sanitizeText(err.message);
  }
  return undefined;
}

function titleFrom(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim().replaceAll(/\s+/g, ' ');
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, TITLE_MAX);
}

function attachFailure(
  record: TraceRecord,
  thrown: unknown,
  lastErr: TraceEvent | undefined,
  canary: string | undefined,
  scrub: ResolvedTraceScrub,
): void {
  if (!record.ok) {
    record.error = publicError(thrown ?? lastErr?.error);
    const inside = internalError(thrown) ?? lastErr?.errorInternal ?? lastErr?.error;
    if (inside) {
      record.errorInternal = scrubStoredText(inside, scrub);
    }
  }
  if (scrub.canary && canary && JSON.stringify(record).includes(canary)) {
    record.errorInternal = OMIT_CANARY;
  }
}

function eventsForTrace(events: TurnEvent[], include: ResolvedTraceInclude): TurnEvent[] {
  if (include.guardrailDecisions) {
    return events;
  }
  return events.filter((event) => event.type !== 'guardrail');
}

function asResolvedPolicy(
  value: ProfileObservabilitySpec | ResolvedObservabilityPolicy | undefined,
): ResolvedObservabilityPolicy {
  if (
    value &&
    typeof value === 'object' &&
    'record' in value &&
    typeof value.record === 'boolean'
  ) {
    return value;
  }
  return resolveObservabilityPolicy(value);
}

async function buildRecord(args: {
  req: TurnRequest;
  events: TurnEvent[];
  started: number;
  model?: string;
  keySlot?: string;
  thrown?: unknown;
  upstreamLog?: unknown;
  canary?: string;
  system?: string;
  generation?: ResolvedGeneration;
  protocol?: Protocol;
  sanitizedReq?: TurnRequest;
  /** Profile observability — omit for defaults (safe scrub, standard include). */
  observability?: ProfileObservabilitySpec | ResolvedObservabilityPolicy;
}): Promise<TraceRecord> {
  const { req, events, started, model, keySlot, thrown, upstreamLog, canary, system, generation } =
    args;
  const protocol = args.protocol;
  const policy = asResolvedPolicy(args.observability);
  const { include, scrub } = policy;
  const traced = args.sanitizedReq ? { request: args.sanitizedReq } : requestForTrace(req);
  const safe = traced.request;
  const input = safe.input ?? {};
  const traceEvents = eventsForTrace(events, include);
  const snapped = await Promise.all(
    traceEvents.map((event) => snapshotEvent(event, include, scrub)),
  );
  const lastErr = [...snapped].reverse().find((row) => row.type === 'error');
  const aborted = isAbortError(thrown);

  const stopKind = stopKindFromEvents(events);
  const done = completedInteraction(upstreamLog);
  const interactionStatus = done?.status;

  const cancelled =
    aborted ||
    stopKind === 'cancelled' ||
    (protocol === 'geminiInteractions' && interactionStatus === 'cancelled');

  const ok = !(thrown || lastErr) && !cancelled;

  const record: TraceRecord = {
    v: TRACE_VERSION,
    id: crypto.randomUUID(),
    ts: started,
    ms: Date.now() - started,
    streamed: true,
    cancelled,
    previousInteractionId: safe.previousInteractionId ?? null,
    store: safe.store ?? null,
    profile: safe.profile,
    input: {
      text: input.text !== undefined ? scrubStoredText(input.text, scrub) : undefined,
      role: input.role,
      slots: input.slots
        ? Object.fromEntries(
            Object.entries(input.slots).map(([key, value]) => [key, scrubStoredText(value, scrub)]),
          )
        : undefined,
      attachments: await hashBlobs(input.attachments),
      voice: await hashBlobs(input.voice),
    },
    events: snapped,
    ok,
  };
  const title = titleFrom(record.input.text);
  if (title) {
    record.title = title;
  }
  const tapeCanary = scrub.canary ? canary : undefined;
  await attachTape(record, {
    upstream: upstreamLog,
    canary: tapeCanary,
    system,
    generation,
    protocol,
    include,
  });
  attachUsage(record, upstreamLog, done, events, include);
  attachResolved(record, { safe, model, keySlot, generation });
  attachFailure(record, thrown, lastErr, canary, scrub);
  if (traced.sanitizeError && !record.errorInternal) {
    record.errorInternal = scrubStoredText(
      `request sanitize for trace failed: ${traced.sanitizeError}`,
      scrub,
    );
  }
  return record;
}

export type { TraceRecord };
export { buildRecord };
