// invariant: Must not import from src/kernel/: the kernel type-imports ProfileObservabilitySpec, and that
// edge stays one-directional.

import type { ResolvedDetect } from '../guardrails/detectors.ts';
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

/**
 * Whether a stored trace is cleaned, and whose patterns clean it. `true` cleans with what each
 * detector reads the turn with; `false` with nothing. The object names the sides, whatever the
 * turn reads with: Theorem's patterns, the host's (`guardrails.detect` patterns and detectors),
 * each on when left out.
 */
export type ScrubSwitch = boolean | { theorem?: boolean; host?: boolean };

/**
 * Scrubbing of stored records. It reads the detectors `guardrails.detect` declares and ignores
 * their actions: a detector set to `ignore` in the turn still cleans the trace. Defaults are on.
 */
export interface TraceScrubSpec {
  /** The data detectors (`ids`, `financial`, `network`, `credentials`) and the host's own. Default: true. */
  sensitive?: ScrubSwitch;
  /** `injection` and `tool_instructions`. Default: true. */
  injection?: ScrubSwitch;
  /** Never persist the canary token. It is Theorem's alone, so the host side adds nothing. Default: true. */
  canary?: ScrubSwitch;
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

  /** Defaults stay on even when `guardrails.detect` is `ignore`. */
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

/** Which optional content a trace record includes, each on or off. */
export interface ResolvedTraceInclude {
  upstreamLog: boolean;
  outboundWire: boolean;
  evidenceRaw: boolean;
  usage: boolean;
  guardrailDecisions: boolean;
  guardrailMatchPreview: boolean;
}

/** A `ScrubSwitch` with its sides filled in; one with both sides off is `false`. */
export type ResolvedScrubSwitch = boolean | { theorem: boolean; host: boolean };

/** What is scrubbed from the text a trace stores: sensitive values, injection and the canary. */
export interface ResolvedTraceScrub {
  sensitive: ResolvedScrubSwitch;
  injection: ResolvedScrubSwitch;
  canary: ResolvedScrubSwitch;
}

/** A profile's observability settings after defaults: whether and where to record, the sample rate, what to include and scrub, and retention and rotation. */
export interface ResolvedObservabilityPolicy {
  /** False when the block is omitted or `writeTo` is `false`/absent. Sampling applies at write. */
  record: boolean;
  writeTo: false | string | TraceSink | undefined;
  sampleRate: number;
  include: ResolvedTraceInclude;
  scrub: ResolvedTraceScrub;
  /** The profile's detectors, whose patterns clean the record. Absent, Theorem's patterns alone. */
  detect?: ResolvedDetect;
  resource: TraceAttributes;
  retainForDays: number;
  rotateAfterMiB: number;
  onWriteError?: (err: unknown) => void;
}
