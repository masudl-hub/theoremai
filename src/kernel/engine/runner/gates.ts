import { scopeOf } from '../../../guardrails/detect-at.ts';
import {
  readReply,
  refusalAfter,
  replyAfter,
  standingBlock,
  TURN_REPLY,
} from '../../../guardrails/detect-reply.ts';
import { WITHHELD_REASON } from '../../../guardrails/egress.ts';
import type { GivenUrls } from '../../../guardrails/egress-urls.ts';
import { TheoremError, throwIfAborted, toErrorEvent } from '../../../guardrails/error.ts';
import { guardrailFromHits, guardrailTurnEvent } from '../../../guardrails/events.ts';
import { retryRejection } from '../../../guardrails/hints.ts';
import { labelText } from '../../../guardrails/labels.ts';
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { replyIsJudged } from '../../../guardrails/progressive-yield.ts';
import { sanitizeTurnRequest } from '../../../guardrails/sanitize.ts';
import type { OwnTools } from '../../../guardrails/tool-leak.ts';
import type {
  GuardrailHit,
  OutboundPayload,
  ResolvedGuardrailPolicy,
} from '../../../guardrails/types.ts';
import { resolveInputParts } from '../../registry/ingress.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import { injectWouldExceedMaxSteps } from '../../stages.ts';
import type { BoundSystem } from '../../system-parts.ts';
import type {
  AttemptReason,
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
import {
  collectItemFailures,
  collectValidationFailures,
  formatValidationFailures,
  type ItemFailure,
  itemSchemaAt,
  type ValidationFailure,
  valueAt,
  withListAt,
} from './schema-validation.ts';
import { applyTurnStage } from './stages.ts';
import {
  type AttemptFlowState,
  appendUserInput,
  type PendingItemFix,
  type StepExecutionState,
} from './state.ts';
import { executeAttempt } from './steps.ts';
import { isWithheldOnBlock, shownToHost } from './stream.ts';

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

/** What judges a reply, and what follows a block. */
type ReplyPolicy = Pick<ResolvedGuardrailPolicy, 'detect' | 'allow' | 'blockedReply'>;

/** The verdict on an attempt's reply, as `guardrails.detect` reads it whole. */
function evaluateEgressOutcome(args: {
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
  /** The names of the profile's tools and of their parameters. */
  ownTools?: OwnTools;
}): {
  outcome: EgressOutcome;
  guardrails: TurnEventOf<'guardrail'>[];
  /** The structured output with its matches replaced, when a detector replaced any. */
  structured?: unknown;
} {
  const { attemptEvents, request, profile, canRetry, promptLeaks } = args;
  const { detect, blockedReply } = args.policy;
  const written = projectOutbound(attemptEvents);
  const scope = scopeOf(args.policy, {
    canary: args.generation.canary,
    canaryGiven: args.canaryGiven,
    privateSystem: args.privateSystem,
    givenUrls: args.givenUrls,
    ...(args.ownTools ? { ownTools: args.ownTools } : {}),
    ...(profile.labels ? { labels: profile.labels } : {}),
  });
  const read = readReply(written, detect, {
    boundary: 'reply',
    ...(args.withheld ? { reportedTo: args.released.length } : {}),
    scope,
  });
  const { payload } = read;
  /** Text that takes the written reply's place, as the host receives it. */
  const replacement = (text: string): EgressOutcome => ({
    action: 'refusal',
    event: { type: 'text', text },
  });
  const stopped = standingBlock(read, promptLeaks);
  // why: A detector's block is reported by its own event, which names the boundary.
  const judged =
    stopped && stopped !== read.blocked
      ? guardrailFromHits('output_final', 'untrusted', stopped, 'block')
      : undefined;
  const guardrails = [...read.events.map(guardrailTurnEvent), ...(judged ? [judged] : [])];

  if (!stopped) {
    if (read.rewritten) {
      // why: Text the stream could not replace as it went: the reply goes out replaced, whole.
      return { outcome: replacement(replyAfter(args.shown, payload.text)), guardrails };
    }
    const replaced = payload.structured !== written.structured;
    return {
      outcome: { action: 'pass' },
      guardrails,
      ...(replaced ? { structured: payload.structured } : {}),
    };
  }

  if (blockedReply.onBlock === 'refuse') {
    return { outcome: replacement(refusalAfter(args.shown, profile.labels)), guardrails };
  }

  if (canRetry) {
    const nextRequest = buildRepairRequest(
      request,
      payload.text,
      retryRejection(stopped, detect, profile.labels),
      labelText('egress.default_repair_guidance', {}, profile.labels),
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

/** Out of retries, the last attempt goes out as it is, carrying what still failed. */
type ValidationOutcome =
  | { action: 'pass'; failed?: ValidationFailure[] }
  | { action: 'retry'; nextRequest: TurnRequest };

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
      'outputs.validation requires outputs.structured with a JSON Schema', // labels-exempt: developer contract error
    );
  }
  const failures = await collectValidationFailures(
    structured.jsonSchema,
    latestStructured,
    validation.fields,
    request.input?.slots,
  );
  if (failures.length === 0) return { action: 'pass' };
  if (!canRetry) return { action: 'pass', failed: failures };
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
  generation: ResolvedGeneration,
): Generator<TurnEvent> {
  for (const ev of events) {
    if (ev.type === 'tokens') {
      continue;
    }
    // why: Thoughts always streamed live; text and media did unless the attempt withheld them.
    if (ev.type === 'thought' || (alreadyStreamedUserVisible && isWithheldOnBlock(ev))) {
      continue;
    }
    const shown = shownToHost(ev, generation);
    if (shown) yield shown;
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
  reason: AttemptReason,
): TurnEventOf<'attempt'> {
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
  } else {
    // why: An image or speech call reads only its input: the repair replaces the prompt.
    const input = resolveInputParts(profile, safe);
    quotesOwnReply(state, input);
    flow.currentGen = { ...flow.currentGen, input };
  }
  const event: TurnEventOf<'attempt'> = { type: 'attempt', attempt: flow.currentAttempt, reason };
  state.allEmittedEvents.push(event);
  return event;
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
    ...(state.ownTools ? { ownTools: state.ownTools } : {}),
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
    yield updateFlowForRetry(flow, state, profile, outcome.nextRequest, 'egress');
    return 'continue';
  }
  return 'pass';
}

/** The refused items of each list, in the reply's own shape and order. */
function refusedLists(refused: ItemFailure[]): unknown {
  let lists: unknown = {};
  for (const path of new Set(refused.map((failure) => failure.path))) {
    const items = refused.filter((failure) => failure.path === path).map(({ item }) => item);
    lists = withListAt(lists, path, items);
  }
  return lists;
}

// why: A type alias, where an interface would not be read as the open record a JSON Schema is.
type FixObjectSchema = {
  type: 'object';
  properties: Record<string, FixObjectSchema | { type: 'array'; items: Record<string, unknown> }>;
  required: string[];
  $defs?: unknown;
};

/**
 * The schema a rewrite of refused items answers under: the reply's shape, holding
 * only the lists that had a refused item.
 *
 * why: Under the reply's own schema the model would write the whole reply again to change one item.
 */
function fixSchemaFor(jsonSchema: Record<string, unknown>, paths: Iterable<string>) {
  const root: FixObjectSchema = { type: 'object', properties: {}, required: [] };
  // why: An item schema may point into the reply schema's definitions.
  if (jsonSchema.$defs !== undefined) root.$defs = jsonSchema.$defs;
  for (const path of paths) {
    const items = itemSchemaAt(jsonSchema, path);
    if (!items) continue;
    const keys = path.split('.');
    let node = root;
    for (const [depth, key] of keys.entries()) {
      if (!node.required.includes(key)) node.required.push(key);
      if (depth === keys.length - 1) {
        node.properties[key] = { type: 'array', items };
        break;
      }
      const next = node.properties[key];
      const child: FixObjectSchema =
        next?.type === 'object' ? next : { type: 'object', properties: {}, required: [] };
      node.properties[key] = child;
      node = child;
    }
  }
  return root;
}

/** `fix.reply` with each refused item replaced by its rewrite, matched by position; one with no rewrite stays as it was. */
function withRewrittenItems(fix: PendingItemFix, rewrite: unknown): unknown {
  let reply = fix.reply;
  for (const path of new Set(fix.refused.map((failure) => failure.path))) {
    const list = valueAt(reply, path);
    const rewritten = valueAt(rewrite, path);
    if (!Array.isArray(list) || !Array.isArray(rewritten)) continue;
    const next = [...list];
    const refusedHere = fix.refused.filter((failure) => failure.path === path);
    for (const [position, failure] of refusedHere.entries()) {
      if (position < rewritten.length) next[failure.index] = rewritten[position];
    }
    reply = withListAt(reply, path, next);
  }
  return reply;
}

/** `reply` without its refused items. */
function withoutItems(reply: unknown, refused: ItemFailure[]): unknown {
  let next = reply;
  for (const path of new Set(refused.map((failure) => failure.path))) {
    const list = valueAt(next, path);
    if (!Array.isArray(list)) continue;
    const gone = new Set(
      refused.filter((failure) => failure.path === path).map(({ index }) => index),
    );
    next = withListAt(
      next,
      path,
      list.filter((_, index) => !gone.has(index)),
    );
  }
  return next;
}

/**
 * Makes `reply` the attempt's structured output, with what the item rules removed.
 *
 * why: The buffered text is the model's own JSON, which no longer matches; held text goes out as the reply that is kept, and streamed text is skipped at release as it always is.
 */
function holdReply(
  state: StepExecutionState,
  reply: unknown,
  removed: ItemFailure[],
  failed?: ValidationFailure[],
): void {
  const event: TurnEventOf<'structured'> = {
    type: 'structured',
    structured: reply,
    ...(removed.length
      ? { removed: removed.map(({ path, reason, item }) => ({ path, reason, item })) }
      : {}),
    ...(failed ? { failed } : {}),
  };
  state.attemptEvents = [
    ...state.attemptEvents.filter((held) => held.type !== 'structured' && held.type !== 'text'),
    { type: 'text', text: JSON.stringify(reply) },
    event,
  ];
}

/** The next attempt rewrites only the refused items, under a schema that holds only their lists. */
function startItemFix(args: {
  flow: AttemptFlowState;
  state: StepExecutionState;
  profile: Profile;
  reply: unknown;
  refused: ItemFailure[];
  structured: NonNullable<ResolvedGeneration['structured']>;
}): TurnEventOf<'attempt'> {
  const { flow, state, profile, reply, refused, structured } = args;
  const positions = new Map<string, number>();
  const rejection = refused
    .map(({ path, reason }) => {
      const position = positions.get(path) ?? 0;
      positions.set(path, position + 1);
      return `${path}[${position}]: ${reason}`;
    })
    .join('\n');
  const nextRequest = buildRepairRequest(
    flow.currentReq,
    refusedLists(refused),
    rejection,
    labelText('repair.items_guidance', {}, profile.labels),
  );
  flow.pendingItemFix = { reply, refused, structured };
  const attempt = updateFlowForRetry(flow, state, profile, nextRequest, 'validation');
  flow.currentGen = {
    ...flow.currentGen,
    structured: {
      id: structured.id,
      jsonSchema: fixSchemaFor(
        structured.jsonSchema,
        refused.map(({ path }) => path),
      ),
    },
  };
  return attempt;
}

async function handleValidationGate(
  validation: NonNullable<ProfileOutputsSpec['validation']>,
  flow: AttemptFlowState,
  state: StepExecutionState,
  profile: Profile,
  latestStructured: unknown,
): Promise<TurnEventOf<'attempt'> | 'pass'> {
  const canRetry = flow.currentAttempt < (validation.maxRetries ?? 0);
  const fix = flow.pendingItemFix;
  let reply = latestStructured;
  if (fix) {
    // why: The attempt that just ended answered under the fix schema; the reply is the one the items were refused in, with the rewrites put back.
    flow.pendingItemFix = undefined;
    flow.currentGen = { ...flow.currentGen, structured: fix.structured };
    reply = withRewrittenItems(fix, latestStructured);
    holdReply(state, reply, []);
  }
  const outcome = await evaluateValidationOutcome({
    validation,
    generation: flow.currentGen,
    latestStructured: reply,
    request: flow.currentReq,
    canRetry,
  });

  if (outcome.action === 'retry') {
    return updateFlowForRetry(flow, state, profile, outcome.nextRequest, 'validation');
  }
  if (reply === undefined) return 'pass';
  if (outcome.failed) markFailed(state, outcome.failed);
  const slots = flow.currentReq.input?.slots;
  const refused = await collectItemFailures(reply, validation.items, {
    ...(slots ? { slots } : {}),
    toolResults: state.toolResults,
  });
  if (refused.length === 0) return 'pass';
  const fixable = refused.filter((failure) => failure.onFail === 'fix');
  const structured = flow.currentGen.structured;
  // invariant: Refused items get one rewrite. Refused again, they are removed.
  if (fixable.length > 0 && canRetry && !fix && structured) {
    return startItemFix({ flow, state, profile, reply, refused: fixable, structured });
  }
  holdReply(state, withoutItems(reply, refused), refused, outcome.failed);
  return 'pass';
}

/** Puts on the attempt's structured output the fields that still failed. */
function markFailed(state: StepExecutionState, failed: ValidationFailure[]): void {
  const held = findLast(state.attemptEvents, (event) => event.type === 'structured');
  if (held) state.attemptEvents[state.attemptEvents.indexOf(held)] = { ...held, failed };
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

    // why: Tool / gate suspension, or no answer to check — do not before_end; finalize with that stop.
    if (
      state.lastStop?.kind === 'tool' ||
      state.lastStop?.kind === 'gate' ||
      state.lastStop?.kind === 'step_limit'
    ) {
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
    if (status !== 'pass') {
      yield status;
      return { status: 'continue' };
    }
  }

  if (validation || judged) {
    // why: Progressive-yield already released text and media live under egress — unless it
    // withheld them mid-stream. A passing final verdict on the full text supersedes
    // that partial-window decision, so the buffer is released instead of dropped.
    const heldVisible = state.withheldVisible || holdsVisible(profile, flow.currentGen);
    yield* yieldBufferedAttemptEvents(state.attemptEvents, !heldVisible, flow.currentGen);
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
