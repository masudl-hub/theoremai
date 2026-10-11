import { lexiconText, TheoremError } from '@theoremjs/agents';
import type { TheoremSessionState } from './session-store.ts';

export interface TheoremSessionLimits {
  maxGates: number;
  maxOperations: number;
  maxCheckpoints: number;
  maxPermissions: number;
  maxStateBytes: number;
  maxInvocationBytes: number;
  maxOutcomeBytes: number;
}

const DEFAULTS: TheoremSessionLimits = {
  maxGates: 32,
  maxOperations: 128,
  maxCheckpoints: 256,
  maxPermissions: 2048,
  maxStateBytes: 32 * 1024 * 1024,
  maxInvocationBytes: 256 * 1024,
  maxOutcomeBytes: 256 * 1024,
};

export function resolveSessionLimits(
  options: Partial<TheoremSessionLimits> = {},
): TheoremSessionLimits {
  const limits = { ...DEFAULTS, ...options };
  if (
    Object.keys(options).some((key) => !Object.hasOwn(DEFAULTS, key)) ||
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new TheoremError('config', lexiconText('error.config'), {
      cause: { code: 'session_limits' },
    });
  }
  return limits;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function capacity(): never {
  throw new TheoremError('unavailable', lexiconText('error.unavailable'), {
    cause: { code: 'session_state_capacity' },
  });
}

export function checkSessionLimits(state: TheoremSessionState, limits: TheoremSessionLimits): void {
  const gates = Object.values(state.gates);
  const operations = Object.values(state.operations);
  if (
    gates.length > limits.maxGates ||
    operations.length > limits.maxOperations ||
    state.providerCheckpoints.length > limits.maxCheckpoints ||
    state.permissions.length > limits.maxPermissions
  )
    capacity();
  for (const gate of gates) if (bytes(gate) > limits.maxInvocationBytes) capacity();
  let reserved = gates.length * limits.maxOutcomeBytes;
  for (const operation of operations) {
    if (
      operation.status !== 'ready' &&
      operation.invocation &&
      bytes(operation.invocation) > limits.maxInvocationBytes
    )
      capacity();
    if (operation.status === 'settled') {
      if (bytes(operation.outcome) > limits.maxOutcomeBytes) capacity();
    } else {
      reserved += limits.maxOutcomeBytes;
      if (operation.status === 'ready' && bytes(operation) > limits.maxInvocationBytes) capacity();
    }
  }
  // invariant: Reserve terminal evidence before dispatch; unresolved records are never evicted to make room.
  if (bytes(state) + reserved > limits.maxStateBytes) capacity();
}
