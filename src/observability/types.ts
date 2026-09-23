/**
 * Profile observability vocabulary — destination, scrub, and include policy.
 *
 * This module is the single source of truth for observability profile types. It
 * must not import from `src/kernel/`: the kernel type-imports
 * `ProfileObservabilitySpec` for `ProfileCommon.observability`, and that edge
 * stays one-directional.
 *
 * @module
 */

import type { TraceSink } from './trace-sink.ts';
import type { TraceAttributes } from './trace-span.ts';

/** Which payloads land in each TraceRecord. Omitted keys use resolved defaults. */
export interface TraceIncludeSpec {
  /** Scrubbed provider rows and frames (`theorem.upstream.row` events). Default: true. */
  upstreamLog?: boolean;
  /** Scrubbed outbound request bodies (`theorem.wire.request` events). Default: false. */
  outboundWire?: boolean;
  /** The provider's raw grounding payload (`raw` on `theorem.grounding` events). Default: false. */
  evidenceRaw?: boolean;
  /** Usage attributes (`gen_ai.usage.*`, `theorem.usage.*`). Default: true. */
  usage?: boolean;
  /**
   * Guardrail decisions (`theorem.guardrail` events). Default: true.
   */
  guardrailDecisions?: boolean;
  /**
   * Keep `GuardrailHit.match` (exact matched substring, capped) on guardrail
   * events in the live stream and TraceRecord. Default: false — debugging only;
   * treat like server logs when enabled.
   */
  guardrailMatchPreview?: boolean;
}

/**
 * Scrubbing of what is written — independent of turn-path `profile.guardrails`.
 * Defaults are safe for a host-confidential store.
 */
export interface TraceScrubSpec {
  /** Strip credentials / PII spans in stored text. Default: true. */
  sensitive?: boolean;
  /** Strip injection spans in the stored request copy. Default: true. */
  injection?: boolean;
  /** Never persist the canary token. Default: true. */
  canary?: boolean;
}

/**
 * Profile observability — what to record, and where.
 *
 * Omit the whole block → no tracing (noop). Prefer `writeTo: '<registered-id>'`
 * in shared profiles; pass a TraceSink only for tests / custom exporters.
 */
export interface ProfileObservabilitySpec {
  /**
   * Destination for completed turn records.
   *
   * - `false` — explicitly off
   * - `string` — host-registered destination id (`registerTraceDestination`)
   * - `TraceSink` — inline writer (tests, OTEL bridge, etc.)
   *
   * `runTurn(..., sink)` still overrides this for one call.
   */
  writeTo?: false | string | TraceSink;

  /**
   * Fraction of traces to record, 0–1 inclusive. Decided by trace id, so every
   * record of one trace is kept or dropped together.
   * Omitted → 1 (every trace). `0` means record none.
   */
  sampleRate?: number;

  /** Which payloads land in each TraceRecord. */
  include?: TraceIncludeSpec;

  /**
   * Process attributes stamped on every record this profile writes
   * (`TraceRecord.resource`), e.g. `{ 'service.name': 'harbor-support' }`.
   * Omitted → `{}`.
   */
  resource?: TraceAttributes;

  /**
   * Scrubbing of stored records — independent of turn-path guardrails.
   * Defaults stay on even when `guardrails.redactSensitive` is false.
   */
  scrub?: TraceScrubSpec;

  /**
   * Days to keep each record, handed to every destination with the record
   * (`TraceWriteContext`): the JSONL writer prunes by it, a host store computes
   * its own expiry from it. `<= 0` keeps records forever. Default: 14.
   */
  retainForDays?: number;

  /** JSONL rotate threshold in MiB when the resolved destination is JSONL. Default: 32. */
  rotateAfterMiB?: number;

  /**
   * Called when record build or destination write fails.
   * Must not throw; tracing never fails the turn.
   */
  onWriteError?: (err: unknown) => void;
}

/** Resolved include flags after defaults. */
export interface ResolvedTraceInclude {
  upstreamLog: boolean;
  outboundWire: boolean;
  evidenceRaw: boolean;
  usage: boolean;
  guardrailDecisions: boolean;
  guardrailMatchPreview: boolean;
}

/** Resolved scrub flags after defaults. */
export interface ResolvedTraceScrub {
  sensitive: boolean;
  injection: boolean;
  canary: boolean;
}

/**
 * Observability policy with defaults applied.
 * Every path resolves through `resolveObservabilityPolicy`.
 */
export interface ResolvedObservabilityPolicy {
  /** False when the block is omitted or `writeTo` is `false`/absent. Sampling applies per trace at write time. */
  record: boolean;
  writeTo: false | string | TraceSink | undefined;
  sampleRate: number;
  include: ResolvedTraceInclude;
  scrub: ResolvedTraceScrub;
  resource: TraceAttributes;
  retainForDays: number;
  rotateAfterMiB: number;
  onWriteError?: (err: unknown) => void;
}
