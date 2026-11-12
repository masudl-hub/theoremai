import {
  type BeginToolOperationResult,
  TheoremError,
  type ToolExecutionCoordinator,
  type ToolOperationClaim,
  type ToolOperationIdentity,
  type ToolOperationOutcome,
  type ToolOperationReply,
} from '@theoremjs/agents';
import {
  detachedReply,
  type SessionToolOperation,
  type TheoremSessionState,
} from './session-store.ts';

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
    (record.status !== 'running' &&
      record.status !== 'background' &&
      record.status !== 'uncertain') ||
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
  if (record?.status === 'background') return { kind: 'background', reply: record.reply };
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
  const reply = before ? detachedReply(before) : undefined;
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
    ...(reply ? { reply } : {}),
    outcome,
    settledAt,
  };
  if (reply) movedInbox(state);
}

/** why: A detached call's end is an item in its conversation's inbox; a hold reads again before it lets go. */
function movedInbox(state: TheoremSessionState): void {
  state.inbox = {
    version: (state.inbox?.version ?? 0) + 1,
    conversations: state.inbox?.conversations ?? {},
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
    detach(claim, reply) {
      return store.mutate(sessionId, (state) => {
        const record = checkedClaim(state, claim);
        if (record.status !== 'running')
          // labels-exempt: internal diagnostic; the user reads tool.execution_uncertain
          unavailable(
            `Tool operation ${claim.operationId} is ${record.status}, so it cannot detach`,
          );
        state.operations[claim.operationId] = {
          ...claim,
          invocation: record.invocation,
          ...(record.pageGrant ? { pageGrant: record.pageGrant } : {}),
          status: 'background',
          reply,
          startedAt: record.startedAt,
          detachedAt: Date.now(),
        };
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
        const reply = detachedReply(record);
        state.operations[claim.operationId] = {
          ...claim,
          invocation: record.invocation,
          ...(record.pageGrant ? { pageGrant: record.pageGrant } : {}),
          ...(reply ? { reply } : {}),
          status: 'uncertain',
          reason,
          detectedAt: Date.now(),
        };
        if (reply) movedInbox(state);
      });
    },
  };
}

/**
 * The application's coordinator, with the session's record kept beside it. The application's
 * decides each call and holds it first; the session's records the same call after it, so the page
 * shows the call and its late end, and a resend reads it back.
 * invariant: A call the application holds and the session already knows breaks the contract; the
 * application's claim stays open for its own sweep.
 */
export function layeredToolCoordinator(
  owner: ToolExecutionCoordinator,
  session: ToolExecutionCoordinator,
): ToolExecutionCoordinator {
  // why: The kernel hands back the owner's claim; the session's token for the same call is kept here.
  const sessionTokens = new Map<string, string>();
  const sessionClaim = (claim: ToolOperationClaim): ToolOperationClaim => {
    const claimToken = sessionTokens.get(claim.operationId);
    // labels-exempt: internal diagnostic; the user reads tool.execution_uncertain
    if (!claimToken)
      unavailable(`The session holds no claim on tool operation ${claim.operationId}`);
    return { ...claim, claimToken };
  };
  const limits = [owner.maxOutcomeBytes, session.maxOutcomeBytes].filter(
    (limit): limit is number => limit !== undefined,
  );
  const { detach } = owner;
  return {
    ...(limits.length > 0 ? { maxOutcomeBytes: Math.min(...limits) } : {}),
    async lookup(identity) {
      return (await owner.lookup(identity)) ?? (await session.lookup(identity));
    },
    async begin(identity) {
      const held = await owner.begin(identity);
      if (held.kind !== 'acquired') return held;
      const recorded = await session.begin(identity);
      if (recorded.kind !== 'acquired')
        unavailable(
          // labels-exempt: internal diagnostic; the user reads tool.execution_uncertain
          `The session already holds tool operation ${identity.operationId}, which its owner had not`,
        );
      sessionTokens.set(identity.operationId, recorded.claimToken);
      return held;
    },
    ...(detach
      ? {
          async detach(claim: ToolOperationClaim, reply: ToolOperationReply) {
            await detach.call(owner, claim, reply);
            await session.detach?.(sessionClaim(claim), reply);
          },
        }
      : {}),
    async settle(claim, outcome) {
      await owner.settle(claim, outcome);
      await session.settle(sessionClaim(claim), outcome);
      sessionTokens.delete(claim.operationId);
    },
    async settleNotStarted(identity, outcome) {
      await owner.settleNotStarted(identity, outcome);
      await session.settleNotStarted(identity, outcome);
    },
    async markUncertain(claim, reason) {
      await owner.markUncertain(claim, reason);
      await session.markUncertain(sessionClaim(claim), reason);
      sessionTokens.delete(claim.operationId);
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
