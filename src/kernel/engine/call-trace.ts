import { resolveTraceWriter } from '../../observability/policy.ts';
import { writeSpans } from '../../observability/trace.ts';
import { type SpanHandle, type SpanOptions, startTrace } from '../../observability/trace-span.ts';
import { endThrownSpan } from './turn-trace.ts';

interface TracedCall {
  /** The root span's name, such as `decide <apiId>`. */
  name: string;
  attributes: SpanOptions['attributes'];
  traceparent?: string;
  /** Host metadata kept on the record. */
  metadata?: Record<string, unknown>;
  /** Where the record goes and how it is cleaned: the profile's settings, or the caller's sink. */
  writer: Parameters<typeof resolveTraceWriter>[0];
}

/**
 * One request that isn't a turn, under a root span: ended OK when `run` returns, with the
 * exception when it throws, and written either way. A failed write never changes the outcome.
 */
async function tracedCall<T>(
  { name, attributes, traceparent, metadata, writer }: TracedCall,
  run: (root: SpanHandle) => Promise<T>,
): Promise<T> {
  const tree = startTrace(name, {
    kind: 'CLIENT',
    attributes,
    ...(traceparent ? { traceparent } : {}),
  });
  const { sink, policy } = resolveTraceWriter(writer);
  try {
    const result = await run(tree.root);
    tree.root.end({ code: 'OK' });
    return result;
  } catch (error) {
    endThrownSpan(tree.root, error);
    throw error;
  } finally {
    await writeSpans(sink, tree.collect(), policy, metadata);
  }
}

export type { TracedCall };
export { tracedCall };
