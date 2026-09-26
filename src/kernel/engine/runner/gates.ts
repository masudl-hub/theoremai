import { hitRules, runEnforcer, WITHHELD_REASON } from '../../../guardrails/egress.ts';
import { TheoremError, throwIfAborted, toErrorEvent } from '../../../guardrails/error.ts';
import { guardrailFromVerdict } from '../../../guardrails/events.ts';
import { lexiconText } from '../../../guardrails/lexicon.ts';
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { sanitizeTurnRequest } from '../../../guardrails/sanitize.ts';
import type {
  GuardrailContext,
  GuardrailHit,
  OutboundPayload,
  ProfileEgressSpec,
  Verdict,
} from '../../../guardrails/types.ts';
import { resolveInputParts } from '../../registry/ingress.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import { getStructured } from '../../registry/schemas.ts';
import { injectWouldExceedMaxSteps } from '../../stages.ts';
import type {
  ModelProvider,
  Profile,
  ProfileOutputsSpec,
  ResolvedGeneration,
  TurnEvent,
  TurnRequest,
  TurnStop,
} from '../../types.ts';
import { findLast } from '../../util/find-last.ts';
import { guardrailAttributes } from '../turn-trace.ts';
import { collectValidationFailures, formatValidationFailures } from './schema-validation.ts';
import { applyTurnStage } from './stages.ts';
import { type AttemptFlowState, appendUserInput, type StepExecutionState } from './state.ts';
import { executeAttempt } from './steps.ts';
import { isWithheldOnBlock } from './stream.ts';

/** A turn whose final output the egress check blocked (withheld or replaced by policy copy). */
const EGRESS_FILTERED_STOP: TurnStop = { kind: 'filtered', native: 'egress' };

/** Reply text only: thoughts are not guarded output (`isGuardedOutput`). */
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
  /** System-prompt leaks the stream withheld: they pin the verdict to block. */
  promptLeaks?: GuardrailHit[];
}): Promise<{ outcome: EgressOutcome; guardrail?: TurnEvent }> {
  const { egress, attemptEvents, generation, request, profile, canRetry, promptLeaks } = args;
  const payload = projectOutbound(attemptEvents);
  const context: GuardrailContext = {
    stage: 'output_final',
    trust: 'untrusted',
    profileId: profile.id,
    ...(profile.lexicon ? { lexicon: profile.lexicon } : {}),
    ...(generation.canary ? { canary: generation.canary } : {}),
    ...(request.input?.slots ? { slots: request.input.slots } : {}),
    ...(request.input?.role ? { role: request.input.role } : {}),
  };
  // The host policy adds checks; it never releases a system-prompt leak.
  const verdict: Verdict = promptLeaks?.length
    ? {
        action: 'block',
        hits: promptLeaks,
        rejection: lexiconText(
          'egress.rejection',
          { rules: hitRules(promptLeaks).join(', ') },
          profile.lexicon,
        ),
      }
    : await runEnforcer(egress.enforce, payload, context);
  const guardrail = guardrailFromVerdict('output_final', 'untrusted', verdict);

  // `flag` is advisory: the hit is recorded, the turn still releases.
  if (verdict.action === 'allow' || verdict.action === 'flag') {
    return { outcome: { action: 'pass' }, guardrail };
  }

  // The policy supplied safe replacement prose — release that instead.
  if (verdict.action === 'redact') {
    return {
      outcome: {
        action: 'refusal',
        event: { type: 'text', text: verdict.text },
      },
      guardrail,
    };
  }

  if (egress.onBlock === 'refuse_to_user') {
    const text = lexiconText('egress.refusal', {}, profile.lexicon);
    return { outcome: { action: 'refusal', event: { type: 'text', text } }, guardrail };
  }

  if (canRetry) {
    const nextRequest = buildRepairRequest(
      request,
      payload.text,
      verdict.rejection,
      lexiconText('egress.default_repair_guidance', {}, profile.lexicon),
    );
    return { outcome: { action: 'retry', nextRequest }, guardrail };
  }

  return {
    outcome: {
      action: 'withhold',
      event: toErrorEvent(new TheoremError('safety', WITHHELD_REASON.egress)),
    },
    guardrail,
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
    throw new TheoremError(
      'config',
      'outputs.validation requires outputs.structured with a JSON Schema', // lexicon-exempt: developer contract error
    );
  }
  const failures = await collectValidationFailures(
    getStructured(structuredId).jsonSchema,
    latestStructured,
    validation.fields,
    request.input?.slots,
  );
  if (failures.length === 0) {
    return { action: 'pass' };
  }
  const error = formatValidationFailures(failures);
  if (canRetry) {
    const nextRequest = buildRepairRequest(request, latestStructured, error);
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
    // Thoughts always streamed live; text and media did unless the attempt withheld them.
    if (ev.type === 'thought' || (alreadyStreamedUserVisible && isWithheldOnBlock(ev))) {
      continue;
    }
    yield ev;
  }
}

/**
 * Start the next attempt with the repair added. The turn is not resolved again:
 * the retry keeps attempt 1's canary, tools and system prompt, and only the
 * repair prompt is new.
 */
function updateFlowForRetry(
  flow: AttemptFlowState,
  state: StepExecutionState,
  profile: Profile,
  nextReq: TurnRequest,
  reason: 'egress' | 'validation',
): void {
  flow.currentAttempt++;
  state.trace.attempt = flow.currentAttempt;
  state.trace.root.event('theorem.attempt.retry', { attempt: flow.currentAttempt, reason });
  flow.currentReq = nextReq;
  const safe = sanitizeTurnRequest(nextReq);
  if (profile.type === 'text') {
    // The conversation is already in turn history: the repair is its next user message.
    appendUserInput(
      state,
      resolveInputParts(profile, { ...safe, input: { repair: safe.input?.repair } }),
    );
    return;
  }
  // An image or speech call reads only its input: the repair replaces the prompt.
  flow.currentGen = { ...flow.currentGen, input: resolveInputParts(profile, safe) };
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
    ...(state.promptLeaks ? { promptLeaks: state.promptLeaks } : {}),
  });

  if (guardrail) {
    if (guardrail.guardrail) {
      state.trace.root.event('theorem.guardrail', guardrailAttributes(guardrail.guardrail));
    }
    state.allEmittedEvents.push(guardrail);
    yield guardrail;
  }

  if (outcome.action === 'refusal') {
    state.lastStop = EGRESS_FILTERED_STOP;
    state.allEmittedEvents.push(outcome.event);
    yield outcome.event;
    return 'terminal';
  }
  if (outcome.action === 'withhold') {
    state.lastStop = EGRESS_FILTERED_STOP;
    yield outcome.event;
    return 'terminal';
  }
  if (outcome.action === 'retry') {
    updateFlowForRetry(flow, state, profile, outcome.nextRequest, 'egress');
    return 'continue';
  }
  return 'pass';
}

async function* handleValidationGate(
  validation: NonNullable<ProfileOutputsSpec['validation']>,
  flow: AttemptFlowState,
  state: StepExecutionState,
  profile: Profile,
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
    updateFlowForRetry(flow, state, profile, outcome.nextRequest, 'validation');
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
  maxRetries: number;
}): AsyncGenerator<TurnEvent, AttemptStepAction> {
  const { flow, state, profile, system, provider, maxRetries } = args;
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
    state.promptLeaks = undefined;
    const attempt = yield* executeAttempt({
      safe: flow.currentReq,
      profile,
      generation: flow.currentGen,
      system,
      provider,
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
      profile,
      latestStructured,
      maxRetries,
    );
    const action = gateStatusToAction(status, 'success');
    if (action) {
      return action;
    }
  }

  if (validation || egress?.enforce) {
    // Progressive-yield already released text and media live under egress — unless it
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
      maxRetries,
    });
    if (step.status === 'terminal' || step.status === 'success') {
      break;
    }
  }
}

export { runAttemptsWithValidation };
