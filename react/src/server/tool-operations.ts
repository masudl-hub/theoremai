import {
  lexiconText,
  TheoremError,
  type ToolExecutionCoordinator,
  type ToolOperationClaim,
  type ToolOperationIdentity,
  type ToolOperationOutcome,
} from '@theoremjs/agents';
import type { SessionToolOperation, TheoremSessionState } from './session-store.ts';

function unavailable(): never {
  throw new TheoremError('unavailable', lexiconText('error.unavailable'));
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
  if (identity.operationId === '__proto__') unavailable();
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
      unavailable();
  } else if (record && !sameOperation(record, identity)) unavailable();
  return record;
}

function checkedClaim(state: TheoremSessionState, claim: ToolOperationClaim) {
  const record = checkedRecord(state, claim);
  if (
    !record ||
    (record.status !== 'running' && record.status !== 'uncertain') ||
    record.claimToken !== claim.claimToken
  )
    unavailable();
  return record;
}

function saveOutcome(
  state: TheoremSessionState,
  identity: ToolOperationIdentity,
  outcome: ToolOperationOutcome,
) {
  const settledAt = Date.now();
  const { operationId, callId, profileId, toolId, invocationHash } = identity;
  state.operations[identity.operationId] = {
    operationId,
    callId,
    profileId,
    toolId,
    invocationHash,
    status: 'settled',
    outcome,
    settledAt,
  };
}

export function sessionToolCoordinator(
  store: { mutate<T>(id: string, change: (state: TheoremSessionState) => T): Promise<T> },
  sessionId: string,
): ToolExecutionCoordinator {
  return {
    begin(identity) {
      const claimToken = crypto.randomUUID();
      const startedAt = Date.now();
      return store.mutate(sessionId, (state) => {
        const record = checkedRecord(state, identity);
        if (record?.status === 'settled') return { kind: 'settled', outcome: record.outcome };
        if (record?.status === 'running') return { kind: 'running' };
        if (record?.status === 'uncertain') return { kind: 'uncertain' };
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
        checkedClaim(state, claim);
        saveOutcome(state, claim, outcome);
      });
    },
    settleNotStarted(identity, outcome) {
      return store.mutate(sessionId, (state) => {
        const record = checkedRecord(state, identity);
        if (record && record.status !== 'ready') unavailable();
        if (outcome.effects !== 'not_started') unavailable();
        saveOutcome(state, identity, outcome);
      });
    },
    markUncertain(claim, reason) {
      return store.mutate(sessionId, (state) => {
        checkedClaim(state, claim);
        state.operations[claim.operationId] = {
          ...claim,
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
