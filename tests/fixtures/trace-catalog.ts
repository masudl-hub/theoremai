// `writeTrace` swallows sink failures, so the sink records what it cannot name instead of throwing,
// and `catalogGate()`, registered last, fails on it.
import { assertEquals } from '@std/assert';
import { memorySink } from '../../src/observability/trace.ts';
import {
  type TraceAttributeMeta,
  traceAttributeMeta,
  traceEventAttributeMeta,
  traceEventMeta,
} from '../../src/observability/trace-catalog.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import type { TraceSink } from '../../src/observability/trace-sink.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkValue(
  missing: Set<string>,
  where: string,
  meta: TraceAttributeMeta,
  value: unknown,
): void {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item === 'string' && meta.options && !meta.open && !(item in meta.options)) {
      missing.add(`${where} = ${item}`);
    }
    if (meta.fields && isObject(item)) {
      for (const [key, nested] of Object.entries(item)) {
        const field = meta.fields[key];
        if (field) checkValue(missing, `${where}.${key}`, field, nested);
        else missing.add(`${where}.${key}`);
      }
    }
  }
}

function uncataloged(record: TraceRecord): string[] {
  const missing = new Set<string>();
  for (const span of record.spans) {
    for (const [key, value] of Object.entries(span.attributes)) {
      const attr = traceAttributeMeta(key);
      if (attr) checkValue(missing, key, attr, value);
      else missing.add(key);
    }
    for (const event of span.events) {
      if (!traceEventMeta(event.name)) missing.add(`event ${event.name}`);
      for (const [key, value] of Object.entries(event.attributes)) {
        const attr = traceEventAttributeMeta(event.name, key);
        if (attr) checkValue(missing, `${event.name} ${key}`, attr, value);
        else missing.add(`${event.name} ${key}`);
      }
    }
    for (const link of span.links) {
      for (const [key, value] of Object.entries(link.attributes ?? {})) {
        const attr = traceAttributeMeta(key);
        if (attr) checkValue(missing, `link ${key}`, attr, value);
        else missing.add(`link ${key}`);
      }
    }
  }
  return [...missing].sort();
}

const recorded = new Set<string>();

/** `memorySink` that also notes every name the trace catalog cannot describe. */
function catalogedSink(into: TraceRecord[]): TraceSink {
  const sink = memorySink(into);
  return {
    write: (record, context) => {
      for (const name of uncataloged(record)) recorded.add(name);
      return sink.write(record, context);
    },
  };
}

/** Register last in a test file: fails on any name its turns recorded without a catalog entry. */
function catalogGate(): void {
  Deno.test('every recorded trace name has a catalog entry', () => {
    assertEquals([...recorded].sort(), []);
  });
}

export { catalogedSink, catalogGate };
