import { TheoremError } from '../guardrails/error.ts';
import { urlAttributes } from '../kernel/engine/turn-trace.ts';
import type { Profile } from '../kernel/types.ts';
import { resolveTraceWriter } from '../observability/policy.ts';
import { writeTrace } from '../observability/trace.ts';
import { buildRecord, type TraceRecord } from '../observability/trace-record.ts';
import type { TraceSink } from '../observability/trace-sink.ts';
import {
  formatTraceparent,
  startTrace,
  type TraceAttributes,
  traceContent,
  traceJson,
} from '../observability/trace-span.ts';

const NANOS_PER_MS = 1_000_000;
const AGENT_NAME = 'gen_ai.agent.name';

interface CutoutTape {
  ok: boolean;
  /** How long the cutout took; the span ends now and starts this long before. */
  ms: number;
  url?: string;
  inSha256?: string;
  outSha256?: string;
  /** The upstream exchange, recorded as a `theorem.upstream.row` event. */
  http?: unknown;
  error?: string;
}

function cutoutAttributes(cutout: CutoutTape): TraceAttributes {
  return {
    ...urlAttributes(cutout.url),
    ...(cutout.inSha256 ? { 'theorem.cutout.input.sha256': cutout.inSha256 } : {}),
    ...(cutout.outSha256 ? { 'theorem.cutout.output.sha256': cutout.outSha256 } : {}),
  };
}

/**
 * Writes the held turn record, then one `cutout` span parented on its root, so both read as one
 * trace. Without a `sink` nothing is written.
 */
async function flushMintTrace(args: {
  /** The profile the held turn ran on; its observability governs both writes. */
  profile: Profile;
  held: TraceRecord[];
  app: Record<string, unknown>;
  cutout: CutoutTape;
  sink?: TraceSink;
}): Promise<void> {
  const [record] = args.held;
  const root = record?.spans[0];
  if (!record || !root || !args.sink) {
    return;
  }
  const ranOn = root.attributes[AGENT_NAME];
  if (ranOn !== args.profile.id) {
    throw new TheoremError(
      'config',
      `flushMintTrace: the held turn ran on '${String(ranOn)}', not '${args.profile.id}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const { sink, policy } = resolveTraceWriter({
    override: args.sink,
    observability: args.profile.observability,
  });
  await writeTrace(sink, Promise.resolve(record), policy);
  const { cutout } = args;
  // One instant: the cutout was reported done now and ran for `ms` before it.
  const now = BigInt(Date.now()) * BigInt(NANOS_PER_MS);
  const tree = startTrace('cutout', {
    clock: { nowUnixNano: () => now },
    kind: 'CLIENT',
    traceparent: formatTraceparent(root.traceId, root.spanId),
    startTimeUnixNano: String(now - BigInt(Math.round(cutout.ms * NANOS_PER_MS))),
    attributes: cutoutAttributes(cutout),
  });
  if (cutout.http !== undefined) {
    tree.root.event('theorem.upstream.row', { row: traceJson(cutout.http) });
  }
  // The host's error text is free text: stored by hash under the scrub, like any exception.
  if (cutout.error) {
    tree.root.event('exception', { 'exception.message': traceContent(cutout.error) });
  }
  tree.root.end({ code: cutout.ok ? 'OK' : 'ERROR' });
  await writeTrace(
    sink,
    buildRecord({
      spans: tree.collect(),
      policy,
      metadata: { ...record.metadata, app: args.app },
    }),
    policy,
  );
}

export type { CutoutTape };
export { flushMintTrace };
