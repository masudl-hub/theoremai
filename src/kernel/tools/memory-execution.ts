import { TheoremError } from '../../guardrails/error.ts';
import {
  type BeginToolOperationResult,
  DEFAULT_MAX_OUTCOME_BYTES,
  operationBroken,
  type ToolExecutionCoordinator,
  type ToolOperationClaim,
  type ToolOperationIdentity,
  type ToolOperationOutcome,
} from './operation.ts';

/** How many operations a memory coordinator tracks before it refuses new ones. */
const DEFAULT_MEMORY_EXECUTION_LIMIT = 256;

export interface MemoryToolExecutionOptions {
  /** The most operations it holds. A full coordinator refuses dispatch and keeps what it has. */
  maxOperations?: number;
  /** The most bytes it keeps for one tool result. Default {@linkcode DEFAULT_MAX_OUTCOME_BYTES}. */
  maxOutcomeBytes?: number;
}

type OperationRecord =
  | { state: 'running'; claimToken: string }
  | { state: 'uncertain' }
  | { state: 'settled'; outcome: ToolOperationOutcome };

/**
 * A coordinator that keeps claims and outcomes in process memory.
 * Use one per turn or per process when nothing needs to resume after a restart.
 * A host that resumes across requests or workers supplies its own `ToolExecutionCoordinator`.
 */
export function createMemoryToolExecution(
  options: MemoryToolExecutionOptions = {},
): ToolExecutionCoordinator {
  const limit = options.maxOperations ?? DEFAULT_MEMORY_EXECUTION_LIMIT;
  const records = new Map<string, OperationRecord>();
  // invariant: callId and operationId never contain a NUL byte, so the joined key is unambiguous.
  const keyOf = (operation: ToolOperationIdentity) =>
    `${operation.callId}\0${operation.operationId}`;
  const known = (
    operation: ToolOperationIdentity,
  ): Exclude<BeginToolOperationResult, { kind: 'acquired' }> | undefined => {
    const record = records.get(keyOf(operation));
    if (!record) return undefined;
    if (record.state === 'settled') return { kind: 'settled', outcome: record.outcome };
    return { kind: record.state };
  };
  const holds = (claim: ToolOperationClaim) => {
    const record = records.get(keyOf(claim));
    return record?.state === 'running' && record.claimToken === claim.claimToken;
  };
  const full = () =>
    new TheoremError(
      'config',
      `The memory tool coordinator holds its maxOperations of ${limit}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  const notHeld = () =>
    operationBroken('The memory tool coordinator holds no running claim for this token'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  return {
    maxOutcomeBytes: options.maxOutcomeBytes ?? DEFAULT_MAX_OUTCOME_BYTES,
    lookup: (operation) => Promise.resolve(known(operation)),
    begin: (operation) => {
      const earlier = known(operation);
      if (earlier) return Promise.resolve(earlier);
      if (records.size >= limit) return Promise.reject(full());
      const claimToken = crypto.randomUUID();
      records.set(keyOf(operation), { state: 'running', claimToken });
      return Promise.resolve({ kind: 'acquired', claimToken });
    },
    settle: (claim, outcome) => {
      if (!holds(claim)) return Promise.reject(notHeld());
      records.set(keyOf(claim), { state: 'settled', outcome });
      return Promise.resolve();
    },
    settleNotStarted: (operation, outcome) => {
      if (records.has(keyOf(operation))) {
        return Promise.reject(
          operationBroken('The memory tool coordinator already has a record for this operation'), // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        );
      }
      if (records.size >= limit) return Promise.reject(full());
      records.set(keyOf(operation), { state: 'settled', outcome });
      return Promise.resolve();
    },
    markUncertain: (claim) => {
      if (!holds(claim)) return Promise.reject(notHeld());
      records.set(keyOf(claim), { state: 'uncertain' });
      return Promise.resolve();
    },
  };
}
