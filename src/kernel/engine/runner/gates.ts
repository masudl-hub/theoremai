import { scopeOf } from '../../../guardrails/detect-at.ts';
import {
  readReply,
  replyAfter,
  standingBlock,
  TURN_REPLY,
} from '../../../guardrails/detect-reply.ts';
import { hitRules, runEnforcer, WITHHELD_REASON } from '../../../guardrails/egress.ts';
import type { GivenUrls } from '../../../guardrails/egress-urls.ts';
import { TheoremError, throwIfAborted, toErrorEvent } from '../../../guardrails/error.ts';
import { guardrailFromVerdict, guardrailTurnEvent } from '../../../guardrails/events.ts';
import { lexiconText } from '../../../guardrails/lexicon.ts';
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { replyIsJudged } from '../../../guardrails/progressive-yield.ts';
import { sanitizeTurnRequest } from '../../../guardrails/sanitize.ts';
import type {
  GuardrailContext,
  GuardrailHit,
  OutboundPayload,
  ResolvedGuardrailPolicy,
  Verdict,
} from '../../../guardrails/types.ts';
import { resolveInputParts } from '../../registry/ingress.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import { injectWouldExceedMaxSteps } from '../../stages.ts';
import type { BoundSystem } from '../../system-parts.ts';
import type {
  ModelProvider,
  Profile,
  ProfileOutputsSpec,
  ResolvedGeneration,
  TurnEvent,
  TurnEventOf,
  TurnRequest,
  TurnStop,
} from '../../types.ts';
import { findLast } from '../../util/find-last.ts';
import { guardrailCheckAttributes } from '../turn-trace.ts';
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

// why: Structured output travels with the text so `outputs.structured` meets egress rather than passing unexamined.
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

/** What a host policy is told about the reply it judges. */
function replyContext(args: {
  generation: ResolvedGeneration;
  request: TurnRequest;
  profile: Profile;
  givenUrls: GivenUrls;
  canaryGiven: boolean;
}): GuardrailContext {
  const { generation, request, profile, givenUrls } = args;
  return {
    stage: 'output_final',
    trust: 'untrusted',
    profileId: profile.id,
    ...(profile.lexicon ? { lexicon: profile.lexicon } : {}),
    ...(generation.canary ? { canary: generation.canary } : {}),
    ...(generation.canary && args.canaryGiven ? { canaryGiven: true } : {}),
    ...(request.input?.slots ? { slots: request.input.slots } : {}),
    ...(request.input?.role ? { role: request.input.role } : {}),
    givenUrls,
  };
}

/** What judges a reply, and what follows a block. */
type ReplyPolicy = Pick<ResolvedGuardrailPolicy, 'egress' | 'detect' | 'allow' | 'blockedReply'>;

/**
 * The verdict on an attempt's reply: `guardrails.detect` reads it first, and a
 * host policy judges what the detectors let through.
 */
async function evaluateEgressOutcome(args: {
  policy: ReplyPolicy;
  attemptEvents: TurnEvent[];
  /** Whether the stream withheld the reply from the host. */
  withheld: boolean;
  /** The reply text the stream's gate released (`StepExecutionState.released`). */
  released: string;
  /** The reply text the host already has: `released`, unless the attempt holds its text to the end. */
  shown: string;
  generation: ResolvedGeneration;
  request: TurnRequest;
  profile: Profile;
  canRetry: boolean;
  /** The leaks of what is the profile's own the stream stopped on: the reading of the whole reply must find them too. */
  promptLeaks?: GuardrailHit[];
  /** Every URL the model has been given this turn. */
  givenUrls: GivenUrls;
  /** Whether the model has been given the canary this turn. */
  canaryGiven: boolean;
  /** The private stretches of the system instruction (`BoundSystem.private`). */
  privateSystem: readonly string[];
}): Promise<{
  outcome: EgressOutcome;
  guardrails: TurnEventOf<'guardrail'>[];
  /** The structured output with its matches replaced, when a detector replaced any. */
  structured?: unknown;
}> {
  const { attemptEvents, request, profile, canRetry, promptLeaks } = args;
  const { egress, detect, blockedReply } = args.policy;
  const written = projectOutbound(attemptEvents);
  const scope = scopeOf(args.policy, {
    canary: args.generation.canary,
    canaryGiven: args.canaryGiven,
    privateSystem: args.privateSystem,
    givenUrls: args.givenUrls,
    ...(profile.lexicon ? { lexicon: profile.lexicon } : {}),
  });
  const read = readReply(written, detect, {
    boundary: 'reply',
    ...(args.withheld ? { reportedTo: args.released.length } : {}),
    scope,
  });
  const { payload } = read;
  /** A reply that replaces the one written, after what the host already has of that one. */
  const replacement = (text: string): EgressOutcome => ({
    action: 'refusal',
    event: { type: 'text', text: replyAfter(args.shown, text) },
  });
  const rejection = (hits: GuardrailHit[]) =>
    lexiconText('egress.rejection', { rules: hitRules(hits).join(', ') }, profile.lexicon);
  const context = replyContext(args);
  // why: The host policy adds checks; it never releases a detector's block.
  const stopped = standingBlock(read, promptLeaks);
  const verdict: Verdict = stopped
    ? { action: 'block', hits: stopped, rejection: rejection(stopped) }
    : egress
      ? await runEnforcer(egress.enforce, payload, context)
      : { action: 'allow' };
  // why: A detector's block is reported by its own event, which names the boundary.
  const judged =
    stopped && stopped === read.blocked
      ? undefined
      : guardrailFromVerdict('output_final', 'untrusted', verdict);
  const guardrails = [...read.events.map(guardrailTurnEvent), ...(judged ? [judged] : [])];

  if (verdict.action === 'allow' || verdict.action === 'flag') {
    if (read.rewritten) {
      // why: Text the stream could not replace as it went: the reply goes out replaced, whole.
      return { outcome: replacement(payload.text), guardrails };
    }
    const replaced = payload.structured !== written.structured;
    return {
      outcome: { action: 'pass' },
      guardrails,
      ...(replaced ? { structured: payload.structured } : {}),
    };
  }

  if (verdict.action === 'redact') {
    return { outcome: replacement(verdict.text), guardrails };
  }

  if (blockedReply.onBlock === 'refuse') {
    const text = lexiconText('egress.refusal', {}, profile.lexicon);
    return { outcome: replacement(text), guardrails };
  }

  if (canRetry) {
    const nextRequest = buildRepairRequest(
      request,
      payload.text,
      verdict.rejection,
      lexiconText('egress.default_repair_guidance', {}, profile.lexicon),
    );
    return { outcome: { action: 'retry', nextRequest }, guardrails };
  }

  return {
    outcome: {
      action: 'withhold',
      event: toErrorEvent(new TheoremError('safety', WITHHELD_REASON.egress)),
    },
    guardrails,
  };
}

/** Out of retries, the last attempt goes out as it is, the same way a pass does. */
type ValidationOutcome = { action: 'pass' } | { action: 'retry'; nextRequest: TurnRequest };

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
  const structured = generation.structured;
  if (!structured) {
    throw new TheoremError(
      'config',
      'outputs.validation requires outputs.structured with a JSON Schema', // lexicon-exempt: developer contract error
    );
  }
  const failures = await collectValidationFailures(
    structured.jsonSchema,
    latestStructured,
    validation.fields,
    request.input?.slots,
  );
  if (failures.length === 0 || !canRetry) {
    return { action: 'pass' };
  }
  const nextRequest = buildRepairRequest(
    request,
    latestStructured,
    formatValidationFailures(failures),
  );
  return { action: 'retry', nextRequest };
}

function* yieldBufferedAttemptEvents(
  events: TurnEvent[],
  alreadyStreamedUserVisible: boolean,
): Generator<TurnEvent> {
  for (const ev of events) {
    if (ev.type === 'tokens') {
      continue;
    }
    // why: Thoughts always streamed live; text and media did unless the attempt withheld them.
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
  const safe = sanitizeTurnRequest(nextReq, profile);
  if (profile.type === 'text') {
    // why: The conversation is already in turn history: the repair is its next user message.
    const before = state.currentHistory.length;
    appendUserInput(
      state,
      resolveInputParts(profile, { ...safe, input: { repair: safe.input?.repair } }),
    );
    for (const message of state.currentHistory.slice(before)) quotesOwnReply(state, message);
    return;
  }
  // why: An image or speech call reads only its input: the repair replaces the prompt.
  const input = resolveInputParts(profile, safe);
  quotesOwnReply(state, input);
  flow.currentGen = { ...flow.currentGen, input };
}

/**
 * A repair hands the stopped reply back, and the model wrote that reply. What
 * carries it gives the model nothing: a canary or a URL in it is still a leak
 * on the next attempt.
 */
function quotesOwnReply(state: StepExecutionState, carrier: object): void {
  state.canaryScanned.add(carrier);
  state.givenUrls.own.add(carrier);
}

/** Whether an attempt holds its reply text to its end: one validated and not streamed. */
function holdsVisible(profile: Profile, generation: ResolvedGeneration): boolean {
  return profileTurnOutputs(profile)?.validation !== undefined && generation.stream === false;
}

async function* handleEgressGate(
  policy: ReplyPolicy,
  flow: AttemptFlowState,
  state: StepExecutionState,
  profile: Profile,
  privateSystem: readonly string[],
): AsyncGenerator<TurnEvent, 'continue' | 'terminal' | 'pass'> {
  const canRetry = flow.currentAttempt < policy.blockedReply.maxRetries;
  const checkStart = performance.now();
  const { outcome, guardrails, structured } = await evaluateEgressOutcome({
    policy,
    attemptEvents: state.attemptEvents,
    withheld: state.withheldVisible === true,
    released: state.released,
    shown: holdsVisible(profile, flow.currentGen) ? '' : state.released,
    generation: flow.currentGen,
    request: flow.currentReq,
    profile,
    canRetry,
    ...(state.promptLeaks ? { promptLeaks: state.promptLeaks } : {}),
    givenUrls: state.givenUrls,
    canaryGiven: state.canaryGiven,
    privateSystem,
  });

  state.trace.root.event(
    'theorem.guardrail',
    guardrailCheckAttributes(
      'egress',
      performance.now() - checkStart,
      guardrails.at(-1)?.guardrail,
      {
        stage: 'output_final',
        trust: 'untrusted',
      },
    ),
  );
  for (const guardrail of guardrails) {
    state.allEmittedEvents.push(guardrail);
    yield guardrail;
  }
  if (structured !== undefined) {
    // why: What validation reads and the host receives is the structured output as replaced.
    const held = findLast(state.attemptEvents, (event) => event.type === 'structured');
    if (held) state.attemptEvents[state.attemptEvents.indexOf(held)] = { ...held, structured };
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

async function handleValidationGate(
  validation: NonNullable<ProfileOutputsSpec['validation']>,
  flow: AttemptFlowState,
  state: StepExecutionState,
  profile: Profile,
  latestStructured: unknown,
): Promise<'continue' | 'pass'> {
  const canRetry = flow.currentAttempt < (validation.maxRetries ?? 0);
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
  return 'pass';
}

type AttemptStepAction =
  | { status: 'terminal' }
  | { status: 'continue' }
  | {
      status: 'success';
    };

function gateStatusToAction(status: 'continue' | 'terminal' | 'pass'): AttemptStepAction | null {
  if (status === 'terminal') {
    return { status: 'terminal' };
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
  system: BoundSystem;
  provider: ModelProvider;
}): AsyncGenerator<TurnEvent, AttemptStepAction> {
  const { flow, state, profile, system, provider } = args;
  const validation = profileTurnOutputs(profile)?.validation;
  const policy = resolveGuardrailPolicy(profile.guardrails);
  const judged = replyIsJudged(policy, TURN_REPLY);

  // invariant: Fresh maxSteps budget per validation/egress attempt. before_end inject
  // re-entry inside this cycle still accumulates stepCount (do not reset there).
  state.stepCount = 0;

  let latestStructured: unknown;
  for (;;) {
    state.attemptEvents = [];
    state.released = '';
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

    // why: Tool / gate suspension — do not before_end; finalize with that stop.
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
      continue;
    }
    break;
  }

  if (judged) {
    const status = yield* handleEgressGate(policy, flow, state, profile, system.private);
    const action = gateStatusToAction(status);
    if (action) {
      return action;
    }
    latestStructured = projectOutbound(state.attemptEvents).structured ?? latestStructured;
  }

  if (validation) {
    const status = await handleValidationGate(validation, flow, state, profile, latestStructured);
    if (status === 'continue') {
      return { status: 'continue' };
    }
  }

  if (validation || judged) {
    // why: Progressive-yield already released text and media live under egress — unless it
    // withheld them mid-stream. A passing final verdict on the full text supersedes
    // that partial-window decision, so the buffer is released instead of dropped.
    const heldVisible = state.withheldVisible || holdsVisible(profile, flow.currentGen);
    yield* yieldBufferedAttemptEvents(state.attemptEvents, !heldVisible);
  }

  return { status: 'success' };
}

async function* runAttemptsWithValidation(
  safe: TurnRequest,
  profile: Profile,
  generation: ResolvedGeneration,
  system: BoundSystem,
  provider: ModelProvider,
  state: StepExecutionState,
): AsyncGenerator<TurnEvent> {
  const { blockedReply } = resolveGuardrailPolicy(profile.guardrails);
  // why: Each gate counts the attempts against its own cap; the turn runs while either has one left.
  const maxRetries = Math.max(
    profileTurnOutputs(profile)?.validation?.maxRetries ?? 0,
    blockedReply.onBlock === 'retry' ? blockedReply.maxRetries : 0,
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
    });
    if (step.status === 'terminal' || step.status === 'success') {
      break;
    }
  }
}

export { runAttemptsWithValidation };
