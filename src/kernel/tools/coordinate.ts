import { errorKind, type TheoremError, throwIfAborted } from '../../guardrails/error.ts';
import { type JsonObject, jsonObjectSchema } from '../json.ts';
import type { ToolGate } from '../turn-events.ts';
import type { TurnEvent } from '../types.ts';
import type { ToolExecuteSettlement } from './execute.ts';
import {
  heldOperation,
  operationBroken,
  operationWireValue,
  type TerminalToolEvent,
  type ToolExecutionCoordinator,
  type ToolOperationClaim,
  type ToolOperationIdentity,
  type ToolOperationOutcome,
  toolInvocationHash,
  toolOperationOutcomeSchema,
  unresolvedOperation,
} from './operation.ts';

class ReplayedOperation {
  constructor(readonly outcome: ToolOperationOutcome) {}
}

/** A gate after the claim cannot pause a call that was already sent; only a sign-in can ask for one there. */
function gateAfterClaim(gate: ToolGate): TheoremError {
  return unresolvedOperation(
    gate.kind === 'auth' ? 'auth' : 'internal',
    `The tool asked for a ${gate.kind} gate after it was sent, so its effects are unknown`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
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
    if (result.kind === 'running' || result.kind === 'uncertain') throw heldOperation(result.kind);
    if (result.kind !== 'acquired' || typeof result.claimToken !== 'string' || !result.claimToken)
      throw operationBroken("The tool coordinator's begin returned no claim"); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
    if (this.claim && event.tool.phase === 'gate') throw gateAfterClaim(event.tool.gate);
    return true;
  }

  async finish(settlement: ToolExecuteSettlement): Promise<TerminalToolEvent | undefined> {
    if (settlement.gated) {
      if (this.claim) throw gateAfterClaim(settlement.gated);
      return undefined;
    }
    if (!this.terminal) throw operationBroken('The tool run ended with no terminal event'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
      throw operationBroken("The tool coordinator's saved outcome is another operation's"); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    this.committed = true;
    return saved;
  }

  failure(error: unknown): unknown {
    if (!this.claim || this.committed) return error;
    return unresolvedOperation(
      errorKind(error),
      'The tool was sent and did not settle, so its effects are unknown', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      error,
    );
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
  if (existing?.kind === 'running' || existing?.kind === 'uncertain')
    throw heldOperation(existing.kind);
  if (existing?.kind === 'settled') {
    if (!authorizeReplay) throw operationBroken('A settled tool operation has no replay check'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
      if (!authorizeReplay) throw operationBroken('A settled tool operation has no replay check'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
