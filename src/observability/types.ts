// Must not import from src/kernel/: the kernel type-imports ProfileObservabilitySpec, and that
// edge stays one-directional.

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
  /** Guardrail decisions (`theorem.guardrail` events). Default: true. */
  guardrailDecisions?: boolean;
  /**
   * Keep `GuardrailHit.match` (the exact matched text) on guardrail events. Default: false;
   * debugging only, so treat the store like server logs when enabled.
   */
  guardrailMatchPreview?: boolean;
}

/** Scrubbing of stored records, independent of turn-path `profile.guardrails`. Defaults are on. */
export interface TraceScrubSpec {
  /** Strip credentials / PII spans in stored text. Default: true. */
  sensitive?: boolean;
  /** Strip injection spans in the stored request copy. Default: true. */
  injection?: boolean;
  /** Never persist the canary token. Default: true. */
  canary?: boolean;
}

/** Omit the whole block for no tracing. */
export interface ProfileObservabilitySpec {
  /**
   * `false` is off, a string is a `registerTraceDestination` id, a TraceSink is an inline writer.
   * `runTurn(..., sink)` still overrides this for one call.
   */
  writeTo?: false | string | TraceSink;

  /**
   * Fraction of traces to record, 0–1 inclusive. Default: 1. Decided by trace id, so every
   * record of one trace is kept or dropped together.
   */
  sampleRate?: number;

  include?: TraceIncludeSpec;

  /** Stamped on every record as `TraceRecord.resource`, e.g. `{ 'service.name': 'harbor' }`. */
  resource?: TraceAttributes;

  /** Defaults stay on even when `guardrails.redactSensitive` is false. */
  scrub?: TraceScrubSpec;

  /**
   * Days to keep each record, handed to every destination with the record
   * (`TraceWriteContext`): the JSONL writer prunes by it, a host store computes
   * its own expiry from it. `<= 0` keeps records forever. Default: 14.
   */
  retainForDays?: number;

  /**
   * File size in MiB at which a file-based destination starts a new file, handed to every
   * destination with the record (`TraceWriteContext`). Default: 32.
   */
  rotateAfterMiB?: number;

  /** Called when record build or destination write fails. Must not throw. */
  onWriteError?: (err: unknown) => void;
}

export interface ResolvedTraceInclude {
  upstreamLog: boolean;
  outboundWire: boolean;
  evidenceRaw: boolean;
  usage: boolean;
  guardrailDecisions: boolean;
  guardrailMatchPreview: boolean;
}

export interface ResolvedTraceScrub {
  sensitive: boolean;
  injection: boolean;
  canary: boolean;
}

export interface ResolvedObservabilityPolicy {
  /** False when the block is omitted or `writeTo` is `false`/absent. Sampling applies at write. */
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
