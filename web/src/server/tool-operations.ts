import {
  type BeginToolOperationResult,
  TheoremError,
  type ToolExecutionCoordinator,
  type ToolOperationClaim,
  type ToolOperationIdentity,
  type ToolOperationOutcome,
} from '@theoremjs/agents';
import type { SessionToolOperation, TheoremSessionState } from './session-store.ts';

/** The session's record of a tool operation does not match the call: the user reads `tool.execution_uncertain`. */
function unavailable(reason: string): never {
  throw new TheoremError('unavailable', reason, { copy: { key: 'tool.execution_uncertain' } });
}

function sameOperation(
  record: Exclude<SessionToolOperation, { status: 'ready' }>,
  identity: ToolOperationIdentity,
): boolean {
  return (
    record.operationId === identity.operationId &&
    record.callId === identity.callId &&
    record.profileId === identity.profileId &&
    record.toolId === identity.toolId &&
    record.invocationHash === identity.invocationHash
  );
}

function checkedRecord(
  state: TheoremSessionState,
  identity: ToolOperationIdentity,
): SessionToolOperation | undefined {
  // labels-exempt: internal diagnostic; the user reads tool.execution_uncertain
  if (identity.operationId === '__proto__') unavailable('The tool operation id is __proto__');
  const record = Object.hasOwn(state.operations, identity.operationId)
    ? state.operations[identity.operationId]
    : undefined;
  if (record?.status === 'ready') {
    if (
      record.pending.callId !== identity.callId ||
      record.pending.profileId !== identity.profileId ||
      record.pending.name !== identity.toolId ||
      record.profileId !== identity.profileId
    )
      // labels-exempt: internal diagnostic; the user reads tool.execution_uncertain
      unavailable(`The ready tool operation ${identity.operationId} is for another call`);
  } else if (record && !sameOperation(record, identity))
    // labels-exempt: internal diagnostic; the user reads tool.execution_uncertain
    unavailable(`The session holds tool operation ${identity.operationId} for another call`);
  return record;
}

function checkedClaim(state: TheoremSessionState, claim: ToolOperationClaim) {
  const record = checkedRecord(state, claim);
  if (
    !record ||
    (record.status !== 'running' && record.status !== 'uncertain') ||
    record.claimToken !== claim.claimToken
  )
    unavailable(
      // labels-exempt: internal diagnostic; the user reads tool.execution_uncertain
      `The claim on tool operation ${claim.operationId} is not the session's running claim`,
    );
  return record;
}

function existingResult(
  record: SessionToolOperation | undefined,
): Exclude<BeginToolOperationResult, { kind: 'acquired' }> | undefined {
  if (record?.status === 'settled') return { kind: 'settled', outcome: record.outcome };
  if (record?.status === 'running') return { kind: 'running' };
  if (record?.status === 'uncertain') return { kind: 'uncertain' };
  return undefined;
}

function saveOutcome(
  state: TheoremSessionState,
  identity: ToolOperationIdentity,
  outcome: ToolOperationOutcome,
) {
  const before = state.operations[identity.operationId];
  const pageGrant = before && before.status !== 'ready' ? before.pageGrant : undefined;
  const settledAt = Date.now();
  const { operationId, callId, profileId, toolId, invocationHash, invocation } = identity;
  state.operations[identity.operationId] = {
    operationId,
    callId,
    profileId,
    toolId,
    invocationHash,
    ...(invocation ? { invocation } : {}),
    status: 'settled',
    ...(pageGrant ? { pageGrant } : {}),
    outcome,
    settledAt,
  };
}

export function sessionToolCoordinator(
  store: {
    readonly capacity?: { maxOutcomeBytes: number };
    mutate<T>(id: string, change: (state: TheoremSessionState) => T): Promise<T>;
  },
  sessionId: string,
): ToolExecutionCoordinator {
  return {
    ...(store.capacity ? { maxOutcomeBytes: store.capacity.maxOutcomeBytes } : {}),
    lookup(identity) {
      return store.mutate(sessionId, (state) => {
        const record = checkedRecord(state, identity);
        return existingResult(record);
      });
    },
    begin(identity) {
      const claimToken = crypto.randomUUID();
      const startedAt = Date.now();
      return store.mutate(sessionId, (state) => {
        const record = checkedRecord(state, identity);
        const existing = existingResult(record);
        if (existing) return existing;
        state.operations[identity.operationId] = {
          ...identity,
          status: 'running',
          claimToken,
          startedAt,
        };
        return { kind: 'acquired', claimToken };
      });
    },
    settle(claim, outcome) {
      return store.mutate(sessionId, (state) => {
        const record = checkedClaim(state, claim);
        saveOutcome(state, { ...claim, invocation: record.invocation }, outcome);
      });
    },
    settleNotStarted(identity, outcome) {
      return store.mutate(sessionId, (state) => {
        const record = checkedRecord(state, identity);
        if (record && record.status !== 'ready')
          unavailable(
            // labels-exempt: internal diagnostic; the user reads tool.execution_uncertain
            `Tool operation ${identity.operationId} is ${record.status}, so it cannot settle as not started`,
          );
        if (outcome.effects !== 'not_started')
          unavailable(
            // labels-exempt: internal diagnostic; the user reads tool.execution_uncertain
            `A not-started settlement of ${identity.operationId} has effects ${outcome.effects}`,
          );
        saveOutcome(state, identity, outcome);
      });
    },
    markUncertain(claim, reason) {
      return store.mutate(sessionId, (state) => {
        const record = checkedClaim(state, claim);
        state.operations[claim.operationId] = {
          ...claim,
          invocation: record.invocation,
          ...(record.pageGrant ? { pageGrant: record.pageGrant } : {}),
          status: 'uncertain',
          reason,
          detectedAt: Date.now(),
        };
      });
    },
  };
}

export function sameAcceptedAnswer(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
