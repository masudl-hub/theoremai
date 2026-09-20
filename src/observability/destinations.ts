/**
 * Host-registered trace destinations for profile `observability.writeTo` ids.
 *
 * THEOREM does not invent filesystem roots. Hosts register a named destination
 * once per process; profiles reference it by id.
 *
 * @module
 */

import { TheoremError } from '../guardrails/error.ts';
import type { TraceSink } from './trace-sink.ts';

/** JSONL directory destination — retention comes from profile policy at resolve time. */
export interface JsonlTraceDestination {
  readonly kind: 'jsonl';
  readonly dir: string;
}

/** Something a host may register under a destination id. */
export type TraceDestination = TraceSink | JsonlTraceDestination;

const destinations = new Map<string, TraceDestination>();

/** Build a JSONL destination descriptor for `registerTraceDestination`. */
function jsonlDestination(dir: string): JsonlTraceDestination {
  const trimmed = dir.trim();
  if (!trimmed) {
    throw new TheoremError('jsonlDestination requires a non-empty directory');
  }
  return { kind: 'jsonl', dir: trimmed };
}

function isJsonlTraceDestination(value: TraceDestination): value is JsonlTraceDestination {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as JsonlTraceDestination).kind === 'jsonl' &&
    typeof (value as JsonlTraceDestination).dir === 'string'
  );
}

function isTraceSink(value: TraceDestination): value is TraceSink {
  return (
    typeof value === 'object' && value !== null && typeof (value as TraceSink).write === 'function'
  );
}

/** Register a named destination for profile `observability.writeTo`. */
function registerTraceDestination(id: string, destination: TraceDestination): void {
  const key = id.trim();
  if (!key) {
    throw new TheoremError('registerTraceDestination requires a non-empty id');
  }
  if (isJsonlTraceDestination(destination)) {
    if (!destination.dir.trim()) {
      throw new TheoremError(`Trace destination '${key}' jsonl dir must be non-empty`);
    }
    destinations.set(key, { kind: 'jsonl', dir: destination.dir.trim() });
    return;
  }
  if (!isTraceSink(destination)) {
    throw new TheoremError(`Trace destination '${key}' must be a TraceSink or jsonl destination`);
  }
  destinations.set(key, destination);
}

/** Look up a registered destination; undefined when missing. */
function getTraceDestination(id: string): TraceDestination | undefined {
  return destinations.get(id);
}

/** Require a registered destination or throw. */
function requireTraceDestination(id: string): TraceDestination {
  const found = getTraceDestination(id);
  if (!found) {
    throw new TheoremError(`Trace destination '${id}' is not registered`);
  }
  return found;
}

/** List registered destination ids (stable sort). */
function listTraceDestinationIds(): string[] {
  return [...destinations.keys()].sort();
}

/** Clear the destination registry (tests). */
function clearTraceDestinations(): void {
  destinations.clear();
}

export {
  clearTraceDestinations,
  getTraceDestination,
  isJsonlTraceDestination,
  isTraceSink,
  jsonlDestination,
  listTraceDestinationIds,
  registerTraceDestination,
  requireTraceDestination,
};
