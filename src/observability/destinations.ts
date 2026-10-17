// invariant: THEOREM does not invent filesystem roots: hosts register a named destination once per process.

import { TheoremError } from '../guardrails/error.ts';
import type { TraceSink } from './trace-sink.ts';

const destinations = new Map<string, TraceSink>();

/** True when the value is a trace sink. */
function isTraceSink(value: unknown): value is TraceSink {
  return (
    typeof value === 'object' &&
    value !== null &&
    'write' in value &&
    typeof value.write === 'function'
  );
}

/** Register a trace sink under an id; throws when the id is empty. */
function registerTraceDestination(id: string, destination: TraceSink): void {
  const key = id.trim();
  if (!key) {
    throw new TheoremError('config', 'registerTraceDestination requires a non-empty id');
  }
  // why: Hosts may call from plain JS: the registry holds only writers.
  if (!isTraceSink(destination)) {
    throw new TheoremError('config', `Trace destination '${key}' must be a TraceSink`);
  }
  destinations.set(key, destination);
}

/** The sink registered under the id, or `undefined`. */
function getTraceDestination(id: string): TraceSink | undefined {
  return destinations.get(id);
}

/** The sink registered under the id; throws when there is none. */
function requireTraceDestination(id: string): TraceSink {
  const found = getTraceDestination(id);
  if (!found) {
    throw new TheoremError('config', `Trace destination '${id}' is not registered`);
  }
  return found;
}

/** The registered destination ids, sorted. */
function listTraceDestinationIds(): string[] {
  return [...destinations.keys()].sort();
}

/** For tests. */
function clearTraceDestinations(): void {
  destinations.clear();
}

export {
  clearTraceDestinations,
  getTraceDestination,
  isTraceSink,
  listTraceDestinationIds,
  registerTraceDestination,
  requireTraceDestination,
};
