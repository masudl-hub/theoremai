import { TheoremError, throwIfAborted } from '../../guardrails/error.ts';
import { lexiconText } from '../../guardrails/lexicon.ts';
import { type JsonObject, jsonObjectSchema } from '../provider-contract.ts';
import type { TurnEvent } from '../types.ts';
import type { ToolExecuteSettlement } from './execute.ts';
import {
  operationUnavailable,
  operationWireValue,
  type TerminalToolEvent,
  type ToolExecutionCoordinator,
  type ToolOperationClaim,
  type ToolOperationIdentity,
  type ToolOperationOutcome,
  toolInvocationHash,
  toolOperationOutcomeSchema,
} from './operation.ts';

class ReplayedOperation {
  constructor(readonly outcome: ToolOperationOutcome) {}
}

function uncertainError(cause?: unknown): TheoremError {
  return new TheoremError('unavailable', lexiconText('tool.execution_uncertain'), {
    copy: { key: 'tool.execution_uncertain' },
    cause,
  });
}

class CoordinatedExecution {
  private claim?: ToolOperationClaim;
  private committed = false;
  private writeFailed = false;
  private terminal?: TerminalToolEvent;

  constructor(
    private coordinator: ToolExecutionCoordinator,
    private operation: ToolOperationIdentity,
    private accepted: JsonObject,
    private signal?: AbortSignal,
  ) {}

  async beginBody(preparedInput: unknown): Promise<ToolOperationClaim> {
    throwIfAborted(this.signal);
    const operation = {
      ...this.operation,
      invocation: { accepted: this.accepted, preparedInput: operationWireValue(preparedInput) },
    };
    const result = await this.coordinator.begin(operation);
    if (result.kind === 'settled') throw new ReplayedOperation(result.outcome);
    if (result.kind === 'running' || result.kind === 'uncertain') throw uncertainError();
    if (result.kind !== 'acquired' || typeof result.claimToken !== 'string' || !result.claimToken)
      throw operationUnavailable();
    this.claim = { ...operation, claimToken: result.claimToken };
    throwIfAborted(this.signal);
    return this.claim;
  }

  observe(event: TurnEvent): boolean {
    if (event.type !== 'tool') return true;
    if (event.tool.phase === 'complete' || event.tool.phase === 'error') {
      this.terminal = { ...event, tool: event.tool };
      return false;
    }
    if (this.claim && event.tool.phase === 'gate') throw uncertainError();
    return true;
  }

  async finish(settlement: ToolExecuteSettlement): Promise<TerminalToolEvent | undefined> {
    if (settlement.gated) {
      if (this.claim) throw uncertainError();
      return undefined;
    }
    if (!this.terminal) throw operationUnavailable();
    const {
      modelResult,
      outputRaw,
      failure,
      awaiting,
      denied,
      callNotStarted,
      aborted,
      pendingInject,
    } = settlement;
    const effects = this.claim ? (failure ? 'unknown' : 'completed') : 'not_started';
    const outcome = {
      event: this.terminal,
      effects,
      replay: {
        modelResult,
        outputRaw,
        failure,
        awaiting,
        denied,
        callNotStarted,
        aborted,
        pendingInject,
      },
    };
    this.writeFailed = true;
    const saved = toolOperationOutcomeSchema.parse(operationWireValue(outcome));
    if (this.claim) await this.coordinator.settle(this.claim, saved);
    else await this.coordinator.settleNotStarted(this.operation, saved);
    this.committed = true;
    return saved.event;
  }

  replay(error: ReplayedOperation): ToolOperationOutcome {
    const saved = toolOperationOutcomeSchema.parse(operationWireValue(error.outcome));
    const { operationId, callId, toolId } = this.operation;
    if (
      saved.event.tool.operationId !== operationId ||
      saved.event.tool.callId !== callId ||
      saved.event.tool.name !== toolId
    )
      throw operationUnavailable();
    this.committed = true;
    return saved;
  }

  failure(error: unknown): unknown {
    return this.claim && !this.committed ? uncertainError(error) : error;
  }

  async close(): Promise<void> {
    if (this.claim && !this.committed) {
      await this.coordinator.markUncertain(
        this.claim,
        this.writeFailed ? 'settlement_write_failed' : 'execution_interrupted',
      );
    }
  }
}

export async function* coordinateTool(
  coordinator: ToolExecutionCoordinator | undefined,
  identity: Omit<ToolOperationIdentity, 'invocationHash'>,
  invocation: unknown,
  signal: AbortSignal | undefined,
  run: (
    beginBody?: (preparedInput: unknown) => Promise<ToolOperationClaim | undefined>,
  ) => AsyncGenerator<TurnEvent, ToolExecuteSettlement>,
  authorizeReplay?: (outcome: ToolOperationOutcome) => void | Promise<void>,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  if (!coordinator) return yield* run();
  const accepted = jsonObjectSchema.parse(operationWireValue(invocation));
  const operation = { ...identity, invocationHash: await toolInvocationHash(accepted) };
  const execution = new CoordinatedExecution(coordinator, operation, accepted, signal);
  throwIfAborted(signal);
  const existing = await coordinator.lookup(operation);
  throwIfAborted(signal);
  if (existing?.kind === 'running' || existing?.kind === 'uncertain') throw uncertainError();
  if (existing?.kind === 'settled') {
    if (!authorizeReplay) throw operationUnavailable();
    const saved = execution.replay(new ReplayedOperation(existing.outcome));
    await authorizeReplay(saved);
    throwIfAborted(signal);
    yield saved.event;
    return saved.replay;
  }
  const iterator = run((input) => execution.beginBody(input));
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        const terminal = await execution.finish(next.value);
        if (terminal) yield terminal;
        return next.value;
      }
      if (execution.observe(next.value)) yield next.value;
    }
  } catch (error) {
    if (error instanceof ReplayedOperation) {
      if (!authorizeReplay) throw operationUnavailable();
      const saved = execution.replay(error);
      await authorizeReplay(saved);
      yield saved.event;
      return saved.replay;
    }
    throw execution.failure(error);
  } finally {
    try {
      await execution.close();
    } finally {
      await iterator.return({});
    }
  }
}
