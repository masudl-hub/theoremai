import { runEnforcer } from '../../../guardrails/egress.ts';
import { TheorumError, throwIfAborted, toErrorEvent } from '../../../guardrails/error.ts';
import { guardrailFromVerdict } from '../../../guardrails/events.ts';
import { lexiconText } from '../../../guardrails/lexicon.ts';
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { sanitizeTurnRequest } from '../../../guardrails/sanitize.ts';
import type {
  GuardrailContext,
  OutboundPayload,
  ProfileEgressSpec,
} from '../../../guardrails/types.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import { resolveTurn } from '../../registry/resolve.ts';
import { getStructured } from '../../registry/schemas.ts';
import type {
  ModelProvider,
  Profile,
  ProfileOutputsSpec,
  ResolvedGeneration,
  TurnEvent,
  TurnRequest,
} from '../../types.ts';
import { findLast } from '../../util/find-last.ts';
import { collectValidationFailures, formatValidationFailures } from './schema-validation.ts';
import { applyTurnStage, injectWouldExceedMaxSteps } from './stages.ts';
import type { AttemptFlowState, StepExecutionState } from './state.ts';
import { executeAttempt } from './steps.ts';

/** Internal reason recorded when a turn is withheld; mapped to public copy on emit. */
const WITHHELD = 'Turn withheld: egress disclosure violation'; // lexicon-exempt: internal marker mapped by publicError

function collectAttemptText(events: TurnEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type === 'text' && event.text) {
      parts.push(event.text);
    }
  }
  return parts.join('');
}

/**
 * Project attempt events into the egress payload.
 *
 * Structured output travels alongside text so a profile with `outputs.structured`
 * is covered by its own egress policy rather than passing unexamined.
 */
function projectOutbound(events: TurnEvent[]): OutboundPayload {
  const structured = findLast(events, (e) => e.type === 'structured')?.structured;
  return {
    text: collectAttemptText(events),
    ...(structured !== undefined ? { structured } : {}),
  };
}

function buildRepairRequest(
  safe: TurnRequest,
  previousOutput: unknown,
  rejection: string,
  repairGuidance?: string,
): TurnRequest {
  return {
    ...safe,
    input: {
      ...safe.input,
      repair: {
        previousOutput:
          typeof previousOutput === 'string' ? previousOutput : JSON.stringify(previousOutput),
        rejection,
        guidance: repairGuidance,
      },
    },
  };
}

type EgressOutcome =
  | { action: 'pass' }
  | { action: 'refusal'; event: TurnEvent }
  | { action: 'retry'; nextRequest: TurnRequest }
  | { action: 'withhold'; event: TurnEvent };

async function evaluateEgressOutcome(args: {
  egress: ProfileEgressSpec;
  attemptEvents: TurnEvent[];
  generation: ResolvedGeneration;
  request: TurnRequest;
  profile: Profile;
  canRetry: boolean;
}): Promise<{ outcome: EgressOutcome; guardrail?: TurnEvent }> {
  const { egress, attemptEvents, generation, request, profile, canRetry } = args;
  const payload = projectOutbound(attemptEvents);
  const context: GuardrailContext = {
    stage: 'output_final',
    trust: 'untrusted',
    profileId: profile.id,
    ...(generation.canary ? { canary: generation.canary } : {}),
    ...(request.input?.slots ? { slots: request.input.slots } : {}),
    ...(request.input?.role ? { role: request.input.role } : {}),
  };
  const verdict = await runEnforcer(egress.enforce, payload, context);
  const guardrail = guardrailFromVerdict('output_final', 'untrusted', verdict);

  // `flag` is advisory: the hit is recorded, the turn still releases.
  if (verdict.action === 'allow' || verdict.action === 'flag') {
    return { outcome: { action: 'pass' }, guardrail };
  }

  // The policy supplied safe replacement prose — release that instead.
  if (verdict.action === 'redact') {
    return {
      outcome: { action: 'refusal', event: { type: 'text', text: verdict.text } },
      guardrail,
    };
  }

  if (egress.onBlock === 'refuse_to_user') {
    // Only emit a text turn when the policy supplied copy. Without it the kernel
    // has nothing to say — an empty text event reads as a successful empty reply —
    // so fall back to the same withheld error the exhausted-retry path uses.
    return {
      outcome: verdict.refusal
        ? { action: 'refusal', event: { type: 'text', text: verdict.refusal } }
        : { action: 'withhold', event: toErrorEvent(WITHHELD) },
      guardrail,
    };
  }

  if (canRetry) {
    const repairGuidance = egress.repairGuidance || lexiconText('egress.default_repair_guidance');
    const nextRequest = buildRepairRequest(
      request,
      payload.text,
      verdict.rejection,
      repairGuidance,
    );
    return { outcome: { action: 'retry', nextRequest }, guardrail };
  }

  return { outcome: { action: 'withhold', event: toErrorEvent(WITHHELD) }, guardrail };
}

type ValidationOutcome =
  | { action: 'pass' }
  | { action: 'retry'; nextRequest: TurnRequest }
  | { action: 'accept'; event: TurnEvent };

async function evaluateValidationOutcome(args: {
  validation: NonNullable<ProfileOutputsSpec['validation']>;
  generation: ResolvedGeneration;
  latestStructured: unknown;
  request: TurnRequest;
  canRetry: boolean;
}): Promise<ValidationOutcome> {
  const { validation, generation, latestStructured, request, canRetry } = args;
  if (latestStructured === undefined) {
    return { action: 'pass' };
  }
  const structuredId = generation.structured;
  if (!structuredId) {
    throw new TheorumError(
      'outputs.validation requires outputs.structured with a JSON Schema', // lexicon-exempt: developer contract error
    );
  }
  const spec = getStructured(structuredId);
  if (!spec.jsonSchema) {
    throw new TheorumError(
      `structured schema '${structuredId}' has no jsonSchema for validation`, // lexicon-exempt: developer contract error
    );
  }
  const failures = await collectValidationFailures(
    spec.jsonSchema,
    latestStructured,
    validation.fields,
    request.input?.slots,
  );
  if (failures.length === 0) {
    return { action: 'pass' };
  }
  const error = formatValidationFailures(failures);
  if (canRetry) {
    const nextRequest = buildRepairRequest(
      request,
      latestStructured,
      error,
      validation.repairGuidance,
    );
    return { action: 'retry', nextRequest };
  }
  return {
    action: 'accept',
    event: { type: 'structured', structured: latestStructured },
  };
}

function* yieldBufferedAttemptEvents(
  events: TurnEvent[],
  alreadyStreamedUserVisible: boolean,
): Generator<TurnEvent> {
  for (const ev of events) {
    if (ev.type === 'tokens') {
      continue;
    }
    // When validation-only, thought/text already streamed live.
    if (alreadyStreamedUserVisible && (ev.type === 'thought' || ev.type === 'text')) {
      continue;
    }
    yield ev;
  }
}

function updateFlowForRetry(flow: AttemptFlowState, nextReq: TurnRequest): void {
  flow.currentAttempt++;
  flow.currentReq = nextReq;
  flow.currentGen = resolveTurn(sanitizeTurnRequest(nextReq)).generation;
}

async function* handleEgressGate(
  egress: ProfileEgressSpec,
  flow: AttemptFlowState,
  state: StepExecutionState,
  profile: Profile,
  maxRetries: number,
): AsyncGenerator<TurnEvent, 'continue' | 'terminal' | 'pass'> {
  const canRetry = flow.currentAttempt < maxRetries;
  const { outcome, guardrail } = await evaluateEgressOutcome({
    egress,
    attemptEvents: state.attemptEvents,
    generation: flow.currentGen,
    request: flow.currentReq,
    profile,
    canRetry,
  });

  if (guardrail) {
    state.allEmittedEvents.push(guardrail);
    yield guardrail;
  }

  if (outcome.action === 'refusal') {
    state.allEmittedEvents.push(outcome.event);
    yield outcome.event;
    return 'terminal';
  }
  if (outcome.action === 'withhold') {
    yield outcome.event;
    return 'terminal';
  }
  if (outcome.action === 'retry') {
    updateFlowForRetry(flow, outcome.nextRequest);
    return 'continue';
  }
  return 'pass';
}

async function* handleValidationGate(
  validation: NonNullable<ProfileOutputsSpec['validation']>,
  flow: AttemptFlowState,
  state: StepExecutionState,
  latestStructured: unknown,
  maxRetries: number,
): AsyncGenerator<TurnEvent, 'continue' | 'terminal' | 'pass'> {
  const canRetry = flow.currentAttempt < maxRetries;
  const outcome = await evaluateValidationOutcome({
    validation,
    generation: flow.currentGen,
    latestStructured,
    request: flow.currentReq,
    canRetry,
  });

  if (outcome.action === 'retry') {
    updateFlowForRetry(flow, outcome.nextRequest);
    return 'continue';
  }
  if (outcome.action === 'accept') {
    state.allEmittedEvents.push(outcome.event);
    yield outcome.event;
    return 'terminal';
  }
  return 'pass';
}

type AttemptStepAction =
  | { status: 'terminal' }
  | { status: 'continue' }
  | {
      status: 'success';
    };

function gateStatusToAction(
  status: 'continue' | 'terminal' | 'pass',
  terminalStatus: 'terminal' | 'success' = 'terminal',
): AttemptStepAction | null {
  if (status === 'terminal') {
    return { status: terminalStatus };
  }
  if (status === 'continue') {
    return { status: 'continue' };
  }
  return null;
}

async function* executeSingleAttemptCycle(args: {
  flow: AttemptFlowState;
  state: StepExecutionState;
  profile: Profile;
  system: string;
  provider: ModelProvider;
  upstream: Record<string, unknown>[];
  maxRetries: number;
}): AsyncGenerator<TurnEvent, AttemptStepAction> {
  const { flow, state, profile, system, provider, upstream, maxRetries } = args;
  const validation = profileTurnOutputs(profile)?.validation;
  const egress = resolveGuardrailPolicy(profile.guardrails).egress;

  // Fresh maxSteps budget per validation/egress attempt. before_end inject
  // re-entry inside this cycle still accumulates stepCount (do not reset there).
  state.stepCount = 0;

  let latestStructured: unknown;
  // before_end may inject and re-enter the step loop under maxSteps.
  for (;;) {
    state.attemptEvents = [];
    state.withheldVisible = false;
    const attempt = yield* executeAttempt({
      safe: flow.currentReq,
      profile,
      generation: flow.currentGen,
      system,
      provider,
      upstream,
      state,
    });
    latestStructured = attempt.latestStructured;

    // Tool / gate suspension — do not before_end; finalize with that stop.
    if (state.lastStop?.kind === 'tool' || state.lastStop?.kind === 'gate') {
      break;
    }
    if (state.lastStop?.kind === 'cancelled') {
      return { status: 'terminal' };
    }

    const beforeEnd = yield* applyTurnStage({
      profile,
      generation: flow.currentGen,
      state,
      stage: 'before_end',
      step: Math.max(state.stepCount, 1),
      onStage: flow.currentReq.onStage,
      signal: flow.currentReq.signal,
      host: flow.currentGen.host,
      injectWouldExceedMaxSteps: injectWouldExceedMaxSteps(
        state.stepCount,
        flow.currentGen.maxSteps,
      ),
    });
    if (beforeEnd.abort) {
      state.lastStop = {
        kind: 'cancelled',
        ...(typeof beforeEnd.abort === 'object' && beforeEnd.abort.reason
          ? { native: beforeEnd.abort.reason }
          : {}),
      };
      return { status: 'terminal' };
    }
    if (beforeEnd.injectCount > 0) {
      // Host extended the turn — another provider step under maxSteps.
      continue;
    }
    break;
  }

  if (egress?.enforce) {
    const status = yield* handleEgressGate(egress, flow, state, profile, maxRetries);
    const action = gateStatusToAction(status, 'terminal');
    if (action) {
      return action;
    }
  }

  if (validation) {
    const status = yield* handleValidationGate(
      validation,
      flow,
      state,
      latestStructured,
      maxRetries,
    );
    const action = gateStatusToAction(status, 'success');
    if (action) {
      return action;
    }
  }

  if (validation || egress?.enforce) {
    // Progressive-yield already released text/thought live under egress — unless it
    // withheld them mid-stream. A passing final verdict on the full text supersedes
    // that partial-window decision, so the buffer is released instead of dropped.
    yield* yieldBufferedAttemptEvents(state.attemptEvents, !state.withheldVisible);
  }

  return { status: 'success' };
}

async function* runAttemptsWithValidation(
  safe: TurnRequest,
  profile: Profile,
  generation: ResolvedGeneration,
  system: string,
  provider: ModelProvider,
  upstream: Record<string, unknown>[],
  state: StepExecutionState,
): AsyncGenerator<TurnEvent> {
  const maxRetries = Math.max(
    profileTurnOutputs(profile)?.validation?.maxRetries ?? 0,
    resolveGuardrailPolicy(profile.guardrails).egress?.maxRetries ?? 0,
  );
  const flow: AttemptFlowState = {
    currentAttempt: 0,
    currentGen: generation,
    currentReq: safe,
  };

  while (flow.currentAttempt <= maxRetries) {
    throwIfAborted(safe.signal);
    const step = yield* executeSingleAttemptCycle({
      flow,
      state,
      profile,
      system,
      provider,
      upstream,
      maxRetries,
    });
    if (step.status === 'terminal' || step.status === 'success') {
      break;
    }
  }
}

export { runAttemptsWithValidation };
