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
import {
  redactSensitiveOnly,
  sanitizeText,
  sanitizeTurnRequestForTrace,
} from '../guardrails/sanitize.ts';
import { sha256 } from '../kernel/engine/hash.ts';
import type { Protocol } from '../kernel/schema.ts';
import type { ResolvedGeneration, TurnBlob, TurnEvent, TurnRequest } from '../kernel/types.ts';
import { attachResolved, attachTape, attachUsage } from './trace-attach.ts';
import { completedInteraction, stopKindFromEvents } from './trace-usage.ts';

const TRACE_VERSION = 2;
const TITLE_MAX = 80;

/** Hash-only image reference stored in trace records. */
export interface TraceImage {
  mimeType: string;
  sha256: string;
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
  select?: string;
  thinking?: boolean;
  metadata?: Record<string, unknown>;
  model?: { id: string; apiId: string };
  bucket?: string;
  generation?: {
    thinking: string;
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

function hashBlobs(blobs: TurnBlob[] | undefined): Promise<TraceImage[]> {
  if (!blobs) {
    return Promise.resolve([]);
  }
  return Promise.all(
    blobs.map(async (blob) => ({
      mimeType: blob.mimeType,
      sha256: await sha256(blob.data),
    })),
  );
}

async function snapshotEvent(event: TurnEvent): Promise<TraceEvent> {
  const row: TraceEvent = { type: event.type };
  if (event.text) {
    row.text = redactSensitiveOnly(event.text);
  }
  if (event.error) {
    row.error = event.error;
  }
  if (event.errorInternal) {
    row.errorInternal = redactSensitiveOnly(event.errorInternal);
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
  if (event.evidence) {
    row.evidence = event.evidence;
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
): void {
  if (!record.ok) {
    record.error = publicError(thrown ?? lastErr?.error);
    const inside = internalError(thrown) ?? lastErr?.errorInternal ?? lastErr?.error;
    if (inside) {
      record.errorInternal = inside;
    }
  }
  if (canary && JSON.stringify(record).includes(canary)) {
    record.errorInternal = OMIT_CANARY;
  }
}

async function buildRecord(args: {
  req: TurnRequest;
  events: TurnEvent[];
  started: number;
  model?: string;
  bucket?: string;
  thrown?: unknown;
  upstreamLog?: unknown;
  canary?: string;
  system?: string;
  generation?: ResolvedGeneration;
  protocol?: Protocol;
  sanitizedReq?: TurnRequest;
}): Promise<TraceRecord> {
  const { req, events, started, model, bucket, thrown, upstreamLog, canary, system, generation } =
    args;
  const protocol = args.protocol;
  const traced = args.sanitizedReq ? { request: args.sanitizedReq } : requestForTrace(req);
  const safe = traced.request;
  const input = safe.input ?? {};
  const snapped = await Promise.all(events.map((event) => snapshotEvent(event)));
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
      text: input.text,
      role: input.role,
      slots: input.slots,
      attachments: await hashBlobs(input.attachments),
      voice: await hashBlobs(input.voice),
    },
    events: snapped,
    ok,
  };
  const title = titleFrom(input.text);
  if (title) {
    record.title = title;
  }
  await attachTape(record, { upstream: upstreamLog, canary, system, generation, protocol });
  attachUsage(record, upstreamLog, done, events);
  attachResolved(record, { safe, model, bucket, generation });
  attachFailure(record, thrown, lastErr, canary);
  if (traced.sanitizeError && !record.errorInternal) {
    record.errorInternal = sanitizeText(
      `request sanitize for trace failed: ${traced.sanitizeError}`,
    );
  }
  return record;
}

export type { TraceRecord };
export { buildRecord };
