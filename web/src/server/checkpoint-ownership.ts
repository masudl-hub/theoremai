import {
  labelText,
  type ProviderCheckpoint,
  providerCheckpointSchema,
  TheoremError,
  type TurnHistoryMessage,
  toolInvocationHash,
} from '@theoremjs/agents';
import { detachedReply, type TheoremSessionState } from './session-store.ts';

type Operation = TheoremSessionState['operations'][string];

export function checkpointIdentity(checkpoint: ProviderCheckpoint): Promise<string> {
  return toolInvocationHash(providerCheckpointSchema.parse(checkpoint));
}

export async function checkpointOwnershipKey(
  identity: string,
  operations: TheoremSessionState['operations'],
): Promise<string> {
  const rows = Object.entries(operations)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, operation]) =>
      operation.status === 'ready'
        ? [id, operation.status, operation.profileId, operation.readyAt]
        : [
            id,
            // invariant: A late settlement of a detached call leaves this row, and its checkpoint, as it was.
            detachedReply(operation) ? 'background' : operation.status,
            operation.profileId,
            operation.toolId,
            operation.invocationHash,
          ],
    );
  const epoch = await toolInvocationHash(rows);
  return `${identity}:${epoch}`;
}

/** What the model read for this call: a detached call's reply, or a settled call's result. */
function readBackOf(operation: Operation): string | undefined {
  const reply = detachedReply(operation);
  if (reply) return reply.event.tool.readBack;
  return operation.status === 'settled' && operation.outcome.effects !== 'unknown'
    ? operation.outcome.event.tool.readBack
    : undefined;
}

export async function requireOwnedCheckpoint(
  identities: readonly string[],
  checkpoint: ProviderCheckpoint | undefined,
  operations: TheoremSessionState['operations'] = {},
  portableHistory?: readonly TurnHistoryMessage[],
): Promise<ProviderCheckpoint | undefined> {
  if (checkpoint === undefined) return undefined;
  const parsed = providerCheckpointSchema.parse(checkpoint);
  const identity = await checkpointIdentity(parsed);
  const key = await checkpointOwnershipKey(identity, operations);
  const records = Object.values(operations);
  const portableSettlements =
    portableHistory !== undefined &&
    records.length > 0 &&
    identities.some((saved) => saved.startsWith(`${identity}:`)) &&
    records.every((operation) => {
      const readBack = readBackOf(operation);
      return (
        operation.status !== 'ready' &&
        readBack !== undefined &&
        portableHistory.some(
          (message) =>
            message.role === 'tool' &&
            message.tool_call_id === operation.callId &&
            message.name === operation.toolId &&
            message.content === readBack,
        )
      );
    });
  if (
    !identities.includes(key) &&
    !portableSettlements &&
    !(records.length === 0 && identities.includes(identity))
  ) {
    throw new TheoremError('request', labelText('session.provider_state_unowned'), {
      copy: { key: 'session.provider_state_unowned' },
    });
  }
  return parsed;
}

export function retainedCheckpointIdentities(
  existing: readonly string[],
  added: readonly string[],
): string[] {
  return [...new Set([...existing, ...added].reverse())].reverse();
}
