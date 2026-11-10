import { describeError, errorKind, TheoremError, throwIfAborted } from '../../guardrails/error.ts';
import type { LabelOverrides } from '../../guardrails/labels.ts';
import { settleable } from '../engine/runner/step-order.ts';
import { hookCrashFailure, hookFailed } from '../hook-failure.ts';
import { type JsonObject, jsonObjectSchema } from '../json.ts';
import type { ToolGate } from '../turn-events.ts';
import type { TurnEvent, TurnTokens } from '../types.ts';
import type {
  ToolBackgroundCall,
  ToolBackgroundSettled,
  ToolDetach,
  ToolSteerReceipt,
} from './background.ts';
import { failureEvent } from './events.ts';
import type { ToolExecuteSettlement } from './execute.ts';
import { formatToolFailureForModel } from './model-text.ts';
import {
  heldOperation,
  operationBroken,
  operationWireValue,
  type TerminalToolEvent,
  type ToolExecutionCoordinator,
  type ToolOperationClaim,
  type ToolOperationIdentity,
  type ToolOperationOutcome,
  type ToolOperationReply,
  toolInvocationHash,
  toolOperationOutcomeSchema,
  toolOperationReplySchema,
  unresolvedOperation,
} from './operation.ts';
import { SteerQueue } from './steer.ts';
import type { ToolFailure } from './types.ts';

class ReplayedOperation {
  constructor(readonly outcome: ToolOperationOutcome) {}
}

class ReplayedReply {
  constructor(readonly reply: ToolOperationReply) {}
}

/** The host's operation store or background service threw. */
class StoreCrashed {
  constructor(readonly error: unknown) {}
}

/**
 * A `TheoremError` from `lookup` or `begin` is the store's answer, such as a held operation or a full
 * session, and keeps its own path; any other throw is a crash.
 */
function storeCrash(error: unknown): unknown {
  return error instanceof TheoremError ? error : new StoreCrashed(error);
}

/** What the run gives a body: its stop signal, and how it tells that the body has ended. */
export interface ToolCallHooks {
  signal: AbortSignal | undefined;
  bodyEnded?: () => void;
  spent?: (tokens: TurnTokens) => void;
  /** A detached agent call's steers, for its agent's own turn. */
  steers?: SteerQueue;
}

export type ToolRun = (
  beginBody: ((preparedInput: unknown) => Promise<ToolOperationClaim | undefined>) | undefined,
  hooks: ToolCallHooks,
) => AsyncGenerator<TurnEvent, ToolExecuteSettlement>;

type ToolRunIterator = ReturnType<ToolRun>;
type PendingStep = ReturnType<ToolRunIterator['next']>;

const FIRED = Symbol('fired');
const CUT = Symbol('cut');

/**
 * invariant: A detachable call owns its stop signal. The turn's signal reaches it only until the
 * reply, so a turn that ends leaves the call to the host's `stop`.
 */
class DetachTrigger {
  private controller = new AbortController();
  private firing = settleable<typeof FIRED>();
  private timer?: ReturnType<typeof setTimeout>;
  private ended = false;
  private forward = () => this.controller.abort();

  constructor(
    private at: ToolDetach['at'],
    private turnSignal: AbortSignal | undefined,
  ) {
    if (turnSignal?.aborted) this.forward();
    turnSignal?.addEventListener('abort', this.forward, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get fired(): Promise<typeof FIRED> {
    return this.firing.promise;
  }

  claimed(): void {
    if (this.ended) return;
    if (this.at === 'claim') this.firing.resolve(FIRED);
    else this.timer = setTimeout(() => this.firing.resolve(FIRED), this.at.afterMs);
  }

  bodyEnded = (): void => {
    this.ended = true;
    clearTimeout(this.timer);
  };

  abort(): void {
    this.controller.abort();
  }

  release(): void {
    this.bodyEnded();
    this.turnSignal?.removeEventListener('abort', this.forward);
  }
}

/** A settled failure in place of what the run gave. */
function failedOutcome(
  base: { name: string; callId: string; operationId?: string },
  effects: ToolOperationOutcome['effects'],
  failure: ToolFailure,
  tokens?: TurnTokens,
): ToolOperationOutcome {
  const { name, callId, operationId } = base;
  const modelResult = formatToolFailureForModel(failure);
  const failed = failureEvent({ name, callId, ...(operationId ? { operationId } : {}) }, failure);
  const event = tokens ? { ...failed, tool: { ...failed.tool, tokens } } : failed;
  return toolOperationOutcomeSchema.parse(
    operationWireValue({ event, effects, replay: { modelResult, failure } }),
  );
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
  private closed = false;
  labels?: LabelOverrides;
  private terminal?: TerminalToolEvent;
  private stopped?: { reason?: string };
  private spent?: TurnTokens;
  private cut = settleable<typeof CUT>();
  private graceTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private coordinator: ToolExecutionCoordinator,
    private operation: ToolOperationIdentity,
    private accepted: JsonObject,
    private signal?: AbortSignal,
    private trigger?: DetachTrigger,
  ) {}

  get callId(): string {
    return this.operation.callId;
  }

  async beginBody(preparedInput: unknown): Promise<ToolOperationClaim> {
    throwIfAborted(this.signal);
    const operation = {
      ...this.operation,
      invocation: { accepted: this.accepted, preparedInput: operationWireValue(preparedInput) },
    };
    let result: Awaited<ReturnType<ToolExecutionCoordinator['begin']>>;
    try {
      result = await this.coordinator.begin(operation);
    } catch (error) {
      throwIfAborted(this.signal);
      throw storeCrash(error);
    }
    if (result.kind === 'settled') throw new ReplayedOperation(result.outcome);
    if (result.kind === 'background') throw new ReplayedReply(result.reply);
    if (result.kind === 'running' || result.kind === 'uncertain') throw heldOperation(result.kind);
    if (result.kind !== 'acquired' || typeof result.claimToken !== 'string' || !result.claimToken)
      throw operationBroken("The tool coordinator's begin returned no claim"); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    this.claim = { ...operation, claimToken: result.claimToken };
    throwIfAborted(this.signal);
    this.trigger?.claimed();
    return this.claim;
  }

  spend(tokens: TurnTokens): void {
    this.spent = tokens;
  }

  observe(event: TurnEvent): boolean {
    if (event.type !== 'tool') return true;
    if (event.tool.phase === 'complete' || event.tool.phase === 'error') {
      this.terminal = { ...event, tool: event.tool };
      this.trigger?.bodyEnded();
      return false;
    }
    if (this.claim && event.tool.phase === 'gate') throw gateAfterClaim(event.tool.gate);
    return true;
  }

  async finish(settlement: ToolExecuteSettlement): Promise<{
    terminal?: TerminalToolEvent;
    settlement: ToolExecuteSettlement;
    crashed?: StoreCrashed;
  }> {
    if (settlement.gated) {
      if (this.claim) throw gateAfterClaim(settlement.gated);
      return { settlement };
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
    const whole = toolOperationOutcomeSchema.parse(operationWireValue(outcome));
    const saved = this.withinLimit(whole);
    const kept = { terminal: saved.event, settlement: saved === whole ? settlement : saved.replay };
    try {
      await this.save(saved);
    } catch (error) {
      throwIfAborted(this.signal);
      return { ...kept, crashed: new StoreCrashed(error) };
    }
    return kept;
  }

  private async save(outcome: ToolOperationOutcome): Promise<void> {
    this.writeFailed = true;
    if (this.claim) await this.coordinator.settle(this.claim, outcome);
    else await this.coordinator.settleNotStarted(this.operation, outcome);
    this.committed = true;
  }

  private base() {
    const { toolId: name, callId, operationId } = this.operation;
    return { name, callId, operationId };
  }

  /**
   * Saves the reply, and only then gives the turn its answer. A failed save stops the body: the
   * model never read a reply, so the work must not go on.
   */
  async detach(
    detach: ToolDetach,
    iterator: ToolRunIterator,
    pending: PendingStep,
    steers: SteerQueue,
  ) {
    const { claim, coordinator, trigger } = this;
    if (!claim || !coordinator.detach || !trigger) {
      throw operationBroken('The tool detached with no claim'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    const reply = detach.reply();
    const done = settleable<ToolBackgroundSettled>();
    const handle = {
      ...this.call(),
      stop: (reason?: string, options?: { graceMs?: number }) => this.stop(reason, options),
      steer: (text: string, options: { id: string }) =>
        this.steer(detach, steers, text, options.id),
      done: done.promise,
    };
    try {
      await coordinator.detach(claim, reply);
      throwIfAborted(this.signal);
      detach.support.service.detached(handle);
    } catch (error) {
      this.writeFailed = !this.signal?.aborted;
      trigger.abort();
      throw this.writeFailed ? new StoreCrashed(error) : error;
    }
    trigger.release();
    this.goOn(detach, iterator, pending).finally(() =>
      done.resolve({ unreadSteers: steers.close() }),
    );
    return reply;
  }

  private call(): ToolBackgroundCall {
    const { operationId, callId, toolId } = this.operation;
    return { operationId, callId, toolId };
  }

  private steer(
    detach: ToolDetach,
    steers: SteerQueue,
    text: string,
    id: string,
  ): ToolSteerReceipt {
    if (this.committed || steers.isClosed) return { queued: false, reason: 'settled' };
    if (this.stopped) return { queued: false, reason: 'stopped' };
    if (detach.refuseSteers) return { queued: false, reason: detach.refuseSteers };
    return steers.push(id, text) ? { queued: true } : { queued: false, reason: 'settled' };
  }

  private stop(reason: string | undefined, options: { graceMs?: number } | undefined): void {
    if (this.committed) return;
    this.stopped ??= reason === undefined ? {} : { reason };
    this.trigger?.abort();
    if (options?.graceMs !== undefined && this.graceTimer === undefined) {
      this.graceTimer = setTimeout(() => this.cut.resolve(CUT), options.graceMs);
    }
  }

  /** Reads the run past the reply, passing its events to the host, until the call settles. */
  private async goOn(
    detach: ToolDetach,
    iterator: ToolRunIterator,
    pending: PendingStep,
  ): Promise<void> {
    const { service, project } = detach.support;
    // why: No turn reads this run, so a crash of the host's own reporter goes to the call's trace.
    const emit = async (event: TurnEvent) => {
      try {
        await service.event(project(event), this.call());
      } catch (error) {
        detach.trace.hookFailed('background', error);
      }
    };
    try {
      await this.drain(iterator, pending, emit);
    } catch (error) {
      detach.trace.hookFailed('execution', error);
    } finally {
      clearTimeout(this.graceTimer);
      const crashed = await this.close();
      if (crashed) detach.trace.hookFailed('execution', crashed.error);
      await Promise.resolve()
        .then(() => detach.trace.end())
        .catch(() => {});
    }
  }

  private async drain(
    iterator: ToolRunIterator,
    first: PendingStep,
    emit: (event: TurnEvent) => Promise<void>,
  ): Promise<void> {
    let pending = first;
    try {
      for (;;) {
        const next = await Promise.race([pending, this.cut.promise]);
        if (next === CUT) {
          // why: The body ignored its stop. It cannot be killed, so nothing reads it again.
          iterator.return({}).catch(() => {});
          return await this.settleStopped(emit);
        }
        if (next.done) return await this.settleAfterReply(next.value, emit);
        if (this.observe(next.value)) await emit(next.value);
        pending = iterator.next();
      }
    } catch (error) {
      if (this.writeFailed) throw error;
      if (this.stopped) return await this.settleStopped(emit);
      await this.settleFailed(
        { code: 'run_failed', kind: errorKind(error), message: describeError(error) },
        emit,
      );
    }
  }

  private async settleAfterReply(
    settlement: ToolExecuteSettlement,
    emit: (event: TurnEvent) => Promise<void>,
  ): Promise<void> {
    if (this.stopped) return this.settleStopped(emit);
    if (settlement.awaiting) {
      return this.settleFailed(
        {
          code: 'awaiting_after_reply',
          kind: 'internal',
          message: 'The tool asked to wait for a result after its turn ended', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        },
        emit,
      );
    }
    // why: No turn is open, so a post_tool inject or abort has nothing to reach.
    const { pendingInject: _inject, aborted: _aborted, ...kept } = settlement;
    const { terminal, crashed } = await this.finish(kept);
    if (terminal) await emit(terminal);
    if (crashed) throw crashed.error;
  }

  /** A stop with a reason settles the call; a shutdown leaves it for `close` to mark. */
  private async settleStopped(emit: (event: TurnEvent) => Promise<void>): Promise<void> {
    const reason = this.stopped?.reason;
    if (reason === undefined) return;
    await this.settleFailed(
      {
        code: reason,
        kind: 'cancelled',
        message: `The tool call was stopped: ${reason}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      },
      emit,
    );
  }

  private async settleFailed(
    failure: ToolFailure,
    emit: (event: TurnEvent) => Promise<void>,
  ): Promise<void> {
    const saved = failedOutcome(this.base(), 'unknown', failure, this.spent);
    await this.save(saved);
    await emit(saved.event);
  }

  /**
   * why: A result the coordinator cannot keep would leave a call that ran unresolved. It settles as
   * a failure that names its size instead, and the model reads that failure, not the result.
   */
  private withinLimit(outcome: ToolOperationOutcome): ToolOperationOutcome {
    const limit = this.coordinator.maxOutcomeBytes;
    if (limit === undefined) return outcome;
    const bytes = new TextEncoder().encode(JSON.stringify(outcome)).byteLength;
    if (bytes <= limit) return outcome;
    const { name } = outcome.event.tool;
    const failure: ToolFailure = {
      code: 'result_too_large',
      kind: 'bad_response',
      message: `The result of ${name} is ${bytes} bytes, more than the ${limit} bytes kept for one tool result`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      details: { bytes, maxOutcomeBytes: limit },
    };
    return failedOutcome(outcome.event.tool, outcome.effects, failure, outcome.event.tool.tokens);
  }

  replay(error: ReplayedOperation): ToolOperationOutcome {
    const saved = toolOperationOutcomeSchema.parse(operationWireValue(error.outcome));
    this.assertOwn(saved, 'outcome');
    this.committed = true;
    return saved;
  }

  replayReply(reply: ToolOperationReply): ToolOperationReply {
    const saved = toolOperationReplySchema.parse(operationWireValue(reply));
    this.assertOwn(saved, 'reply');
    this.committed = true;
    return saved;
  }

  private assertOwn(
    saved: { event: ToolOperationReply['event'] | TerminalToolEvent },
    what: string,
  ) {
    const { operationId, callId, toolId } = this.operation;
    const { tool } = saved.event;
    if (tool.operationId !== operationId || tool.callId !== callId || tool.name !== toolId)
      throw operationBroken(`The tool coordinator's saved ${what} is another operation's`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }

  failure(error: unknown): unknown {
    if (!this.claim || this.committed) return error;
    return unresolvedOperation(
      errorKind(error),
      'The tool was sent and did not settle, so its effects are unknown', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      error,
    );
  }

  /** Marks a call that did not settle, once. A store that throws here gives its crash back. */
  async close(): Promise<StoreCrashed | undefined> {
    if (this.closed || !this.claim || this.committed) return undefined;
    this.closed = true;
    try {
      await this.coordinator.markUncertain(
        this.claim,
        this.writeFailed ? 'settlement_write_failed' : 'execution_interrupted',
      );
    } catch (error) {
      return new StoreCrashed(error);
    }
    return undefined;
  }

  /** A call the store could not start or keep: it fails, and the model reads that failure. */
  failed(crashed: StoreCrashed): { event: TerminalToolEvent; settlement: ToolExecuteSettlement } {
    const effects = this.claim ? 'unknown' : 'not_started';
    const outcome = failedOutcome(
      this.base(),
      effects,
      hookCrashFailure(crashed.error, this.labels, this.claim !== undefined),
      this.spent,
    );
    const settlement = this.claim ? outcome.replay : { ...outcome.replay, callNotStarted: true };
    return { event: outcome.event, settlement };
  }
}

/** What a saved operation gives the turn, once the replay check has passed. */
async function replayed(
  execution: CoordinatedExecution,
  saved: ReplayedOperation | ReplayedReply,
  authorizeReplay: ((outcome?: ToolOperationOutcome) => void | Promise<void>) | undefined,
): Promise<ToolOperationOutcome | ToolOperationReply> {
  if (!authorizeReplay) throw operationBroken('A settled tool operation has no replay check'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  if (saved instanceof ReplayedReply) {
    const reply = execution.replayReply(saved.reply);
    await authorizeReplay();
    return reply;
  }
  const outcome = execution.replay(saved);
  await authorizeReplay(outcome);
  return outcome;
}

function savedResult(known: Awaited<ReturnType<ToolExecutionCoordinator['lookup']>>) {
  if (known?.kind === 'background') return new ReplayedReply(known.reply);
  if (known?.kind === 'settled') return new ReplayedOperation(known.outcome);
  return undefined;
}

/** A detaching call's trigger and steers, and the hooks its body gets from them. */
function detaching(detach: ToolDetach, signal: AbortSignal | undefined) {
  const trigger = new DetachTrigger(detach.at, signal);
  const steers = new SteerQueue();
  const hooks: Pick<ToolCallHooks, 'bodyEnded' | 'steers'> = {
    bodyEnded: trigger.bodyEnded,
    ...(detach.refuseSteers ? {} : { steers }),
  };
  return { plan: detach, trigger, steers, hooks };
}

/** The store's saved operation, or its crash; a `TheoremError` is its answer and is thrown. */
async function lookup(
  coordinator: ToolExecutionCoordinator,
  operation: ToolOperationIdentity,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ToolExecutionCoordinator['lookup']>> | StoreCrashed> {
  try {
    return await coordinator.lookup(operation);
  } catch (error) {
    throwIfAborted(signal);
    const crash = storeCrash(error);
    if (crash instanceof StoreCrashed) return crash;
    throw crash;
  }
}

/** Marks a call that did not settle, and reports each store crash once. */
async function* closeReporting(
  execution: CoordinatedExecution,
  crashed?: StoreCrashed,
): AsyncGenerator<TurnEvent> {
  const closeCrashed = await execution.close();
  for (const crash of [crashed, closeCrashed]) {
    if (crash) yield hookFailed('execution', crash.error, { callId: execution.callId });
  }
}

/** A call the store could not start or keep fails, and its crash is reported. */
async function* failCall(
  execution: CoordinatedExecution,
  crash: StoreCrashed,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  const failed = execution.failed(crash);
  yield failed.event;
  yield* closeReporting(execution, crash);
  return failed.settlement;
}

export async function* coordinateTool(
  coordinator: ToolExecutionCoordinator | undefined,
  identity: Omit<ToolOperationIdentity, 'invocationHash'>,
  invocation: unknown,
  signal: AbortSignal | undefined,
  run: ToolRun,
  authorizeReplay?: (outcome?: ToolOperationOutcome) => void | Promise<void>,
  /** A call that may finish in the background, and the profile's wording. */
  call: { detach?: ToolDetach; labels?: LabelOverrides } = {},
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  if (!coordinator) return yield* run(undefined, { signal });
  const { detach, labels } = call;
  const accepted = jsonObjectSchema.parse(operationWireValue(invocation));
  const operation = { ...identity, invocationHash: await toolInvocationHash(accepted) };
  const detached = detach ? detaching(detach, signal) : undefined;
  const trigger = detached?.trigger;
  const callSignal = trigger ? trigger.signal : signal;
  const execution = new CoordinatedExecution(coordinator, operation, accepted, callSignal, trigger);
  execution.labels = labels;
  throwIfAborted(signal);
  const existing = await lookup(coordinator, operation, signal);
  if (existing instanceof StoreCrashed) return yield* failCall(execution, existing);
  throwIfAborted(signal);
  if (existing?.kind === 'running' || existing?.kind === 'uncertain')
    throw heldOperation(existing.kind);
  const known = savedResult(existing);
  if (known) {
    const saved = await replayed(execution, known, authorizeReplay);
    throwIfAborted(signal);
    yield saved.event;
    return saved.replay;
  }
  const iterator = run((input) => execution.beginBody(input), {
    signal: callSignal,
    spent: (tokens) => execution.spend(tokens),
    ...detached?.hooks,
  });
  let handedOff = false;
  try {
    let pending = iterator.next();
    for (;;) {
      const next = await (trigger ? Promise.race([pending, trigger.fired]) : pending);
      if (next === FIRED) {
        if (!detached) throw operationBroken('The tool detached with no plan'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        const reply = await execution.detach(detached.plan, iterator, pending, detached.steers);
        handedOff = true;
        yield reply.event;
        return { ...reply.replay };
      }
      if (next.done) {
        const { terminal, settlement, crashed } = await execution.finish(next.value);
        if (terminal) yield terminal;
        yield* closeReporting(execution, crashed);
        return settlement;
      }
      if (execution.observe(next.value)) yield next.value;
      pending = iterator.next();
    }
  } catch (error) {
    if (error instanceof ReplayedOperation || error instanceof ReplayedReply) {
      const saved = await replayed(execution, error, authorizeReplay);
      yield saved.event;
      return saved.replay;
    }
    if (error instanceof StoreCrashed) return yield* failCall(execution, error);
    throw execution.failure(error);
  } finally {
    if (!handedOff) {
      trigger?.release();
      try {
        // why: A crash here has no reader: the turn already ends on another error, or was stopped.
        await execution.close();
      } finally {
        await iterator.return({});
        await detach?.trace.end();
      }
    }
  }
}
