import { TheorumError, throwIfAborted, toErrorEvent } from '../../../guardrails/error.ts';
import { sanitizeTurnRequest } from '../../../guardrails/sanitize.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import { resolveTurn } from '../../registry/resolve.ts';
import { getStructured } from '../../registry/schemas.ts';
import type {
  ModelProvider,
  Profile,
  ProfileEgressSpec,
  ProfileOutputsSpec,
  ResolvedGeneration,
  TurnEvent,
  TurnRequest,
} from '../../types.ts';
import { collectValidationFailures, formatValidationFailures } from './schema-validation.ts';
import type { AttemptFlowState, StepExecutionState } from './state.ts';
import { executeAttempt } from './steps.ts';

function collectAttemptText(events: TurnEvent[]): string {
  return events
    .filter((e) => e.type === 'text' && e.text)
    .map((e) => e.text)
    .join('');
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
}): Promise<EgressOutcome> {
  const { egress, attemptEvents, generation, request, profile, canRetry } = args;
  const attemptText = collectAttemptText(attemptEvents);
  const result = await egress.enforce({
    text: attemptText,
    canary: generation.canary,
    slots: request.input?.slots,
    profile,
    role: request.input?.role,
  });

  if (!result.blocked) {
    return { action: 'pass' };
  }

  if (egress.onBlock === 'refuse_to_user') {
    return { action: 'refusal', event: { type: 'text', text: result.text } };
  }

  if (canRetry) {
    const rejectionMsg = result.rejectionMessage || 'Egress disclosure violation detected.';
    const repairGuidance =
      egress.repairGuidance ||
      'Rewrite the message as corrected user-visible prose only. Keep the same helpful substance; scrub all internal tool names, leak phrases, and disclosure markers.';
    const nextRequest = buildRepairRequest(request, attemptText, rejectionMsg, repairGuidance);
    return { action: 'retry', nextRequest };
  }

  return {
    action: 'withhold',
    event: toErrorEvent('Turn withheld: egress disclosure violation'),
  };
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
    throw new TheorumError('outputs.validation requires outputs.structured with a JSON Schema');
  }
  const spec = getStructured(structuredId);
  if (!spec.jsonSchema) {
    throw new TheorumError(`structured schema '${structuredId}' has no jsonSchema for validation`);
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
  const outcome = await evaluateEgressOutcome({
    egress,
    attemptEvents: state.attemptEvents,
    generation: flow.currentGen,
    request: flow.currentReq,
    profile,
    canRetry,
  });

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
  const egress = profile.guardrails?.egress;

  state.attemptEvents = [];
  const { latestStructured } = yield* executeAttempt({
    safe: flow.currentReq,
    profile,
    generation: flow.currentGen,
    system,
    provider,
    upstream,
    state,
  });

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
    // Progressive-yield already released text/thought live under egress.
    yield* yieldBufferedAttemptEvents(state.attemptEvents, true);
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
    profile.guardrails?.egress?.maxRetries ?? 0,
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
