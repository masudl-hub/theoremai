// THEOREM does not invent filesystem roots: hosts register a named destination once per process.

import { TheoremError } from '../guardrails/error.ts';
import type { TraceSink } from './trace-sink.ts';

const destinations = new Map<string, TraceSink>();

function isTraceSink(value: unknown): value is TraceSink {
  return (
    typeof value === 'object' &&
    value !== null &&
    'write' in value &&
    typeof value.write === 'function'
  );
}

function registerTraceDestination(id: string, destination: TraceSink): void {
  const key = id.trim();
  if (!key) {
    throw new TheoremError('config', 'registerTraceDestination requires a non-empty id');
  }
  // Hosts may call from plain JS: the registry holds only writers.
  if (!isTraceSink(destination)) {
    throw new TheoremError('config', `Trace destination '${key}' must be a TraceSink`);
  }
  destinations.set(key, destination);
}

function getTraceDestination(id: string): TraceSink | undefined {
  return destinations.get(id);
}

function requireTraceDestination(id: string): TraceSink {
  const found = getTraceDestination(id);
  if (!found) {
    throw new TheoremError('config', `Trace destination '${id}' is not registered`);
  }
  return found;
}

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
