import { throwIfAborted } from '../guardrails/error.ts';
import { guardrailFromHits } from '../guardrails/events.ts';
import { detectionForTrust, resolveGuardrailPolicy } from '../guardrails/policy.ts';
import { sanitizeHistory } from '../guardrails/sanitize.ts';
import type { GuardrailHit } from '../guardrails/types.ts';
import type { SpanHandle } from '../observability/trace-span.ts';
import { guardrailAttributes } from './engine/turn-trace.ts';
import type { StageApplyWarningCode, TurnStage } from './schema.ts';
import type { TurnStop } from './stop.ts';
import type { ModelToolResult, ToolFailure, ToolGate } from './tools/types.ts';
import {
  type AwaitingUserInput,
  awaitingUserInputSchema,
  type StageApplyWarning,
  type TurnEventOf,
} from './turn-events.ts';
import type { Profile, TurnEvent, TurnHistoryMessage } from './types.ts';
import { isRecord } from './util/record.ts';

export type { AwaitingUserInput, ToolGate };

/** What a stage handler can ask for: inject messages, abort, deny a tool call, ask for confirmation or mutate it. */
export const STAGE_AFFORDANCES = ['inject', 'abort', 'deny', 'confirm', 'mutate'] as const;
/** One of {@linkcode STAGE_AFFORDANCES}. */
export type StageAffordance = (typeof STAGE_AFFORDANCES)[number];

/** Inject still needs the inject gate at apply time. Empty = observe only. */
export const STAGE_AFFORDANCE_MATRIX: Readonly<Record<TurnStage, readonly StageAffordance[]>> =
  Object.freeze({
    pre_turn: Object.freeze(['inject', 'abort'] as const),
    pre_tool: Object.freeze(['abort', 'deny', 'confirm', 'mutate'] as const),
    post_tool: Object.freeze(['inject', 'abort', 'deny', 'mutate'] as const),
    before_end: Object.freeze(['inject', 'abort'] as const),
    post_turn: Object.freeze([] as const),
  });

const STAGE_RESULT_KEYS = new Set<string>([...STAGE_AFFORDANCES, 'injectId']);

export type StageCallBag = {
  callId?: string;
  tool?: string;
  input?: unknown;
  callNotStarted?: boolean;
  outputRaw?: unknown;
  outputModel?: ModelToolResult;
  failure?: ToolFailure;
  awaiting?: boolean;
  stop?: TurnStop;
  gate?: ToolGate;
};

/** What a stage handler is given: the stage, the step and what has happened so far. */
export interface StageContext extends StageCallBag {
  stage: TurnStage;
  /** 1-based provider step (text) or utterance cycle index (live). */
  step: number;
  history: readonly TurnHistoryMessage[];
  /** Opaque host slot — never traced or client-forwarded by the kernel. */
  host?: unknown;
}

/** What a stage handler returns: what it asks the turn to do. */
export interface StageResult {
  inject?: TurnHistoryMessage[];
  /**
   * Names this `inject` in the `stage` event that records it landing. A blank or
   * non-string id refuses the inject whole.
   */
  injectId?: string;
  abort?: boolean | { reason?: string };
  /** `pre_tool`: refuse the call. `post_tool`: replace the result with this failure. */
  deny?: { code?: string; message?: string };
  /** `pre_tool` only — request a confirm/permission gate. */
  confirm?: true | { summary?: string };
  /** `pre_tool`: replace the call input. `post_tool`: replace the raw output. Both re-validate. */
  mutate?: StageMutate;
}

/** A rewrite of a tool call's input or output. */
export type StageMutate = { input: unknown } | { output: unknown };

/** A host function the turn calls at each stage. */
export type StageHandler = (
  ctx: StageContext,
) => StageResult | undefined | Promise<StageResult | undefined>;

export type { StageApplyWarning, StageApplyWarningCode };

/** A stage handler's result and the stage it came from, to be applied. */
export interface StageApplyInput {
  stage: TurnStage;
  result: unknown;
  injectAllowed: boolean;
  injectWouldExceedMaxSteps?: boolean;
  /**
   * False when the stage's mutate subject is absent at this fire (a `post_tool`
   * whose body never completed, or a tool whose output the kernel must own).
   * `mutate` is then a `mutate_invalid` warning, never a silent no-op.
   */
  mutable?: boolean;
}

export interface InjectUnit {
  id?: string;
  messages: TurnHistoryMessage[];
}

/** A stage handler's result after validation: the parts the turn will act on. */
export interface StageApplyOutput {
  inject?: InjectUnit;
  abort?: boolean | { reason?: string };
  deny?: { code: string; message: string };
  confirm?: { summary?: string };
  mutate?: StageMutate;
  warnings: StageApplyWarning[];
}

/** True when the affordance is physically allowed at `stage` (ignores inject gate). */
export function stageAllowsAffordance(stage: TurnStage, affordance: StageAffordance): boolean {
  return STAGE_AFFORDANCE_MATRIX[stage].includes(affordance);
}

function warn(
  warnings: StageApplyWarning[],
  code: StageApplyWarningCode,
  field: string,
  message: string,
): void {
  warnings.push({ code, field, message });
}

/** True when a tool output asks the turn to pause for the user. */
export function isAwaitingUserInput(output: unknown): output is AwaitingUserInput {
  return awaitingUserInputSchema.safeParse(output).success;
}

/** Drops unknown keys and rejects `role: 'tool'`; sanitizeHistory runs at the inject site. */
function coerceInjectMessage(
  item: unknown,
  warnings: StageApplyWarning[],
): TurnHistoryMessage | undefined {
  if (!isRecord(item)) {
    warn(warnings, 'inject_invalid_messages', 'inject', 'inject entry must be an object'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return undefined;
  }
  if (item.role === 'tool') {
    warn(
      warnings,
      'inject_invalid_messages',
      'inject',
      'inject messages with role "tool" are rejected', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
    return undefined;
  }
  if (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system') {
    warn(
      warnings,
      'inject_invalid_messages',
      'inject',
      `inject role not allowed: ${String(item.role)}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
    return undefined;
  }

  const msg: TurnHistoryMessage = { role: item.role };

  if (item.content !== undefined) {
    if (typeof item.content !== 'string') {
      warn(
        warnings,
        'inject_invalid_messages',
        'inject',
        'inject content must be a string when present', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
      return undefined;
    }
    msg.content = item.content;
  }
  if (item.parts !== undefined) {
    if (!Array.isArray(item.parts)) {
      warn(
        warnings,
        'inject_invalid_messages',
        'inject',
        'inject parts must be an array when present', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
      return undefined;
    }
    msg.parts = item.parts as TurnHistoryMessage['parts'];
  }
  if (item.tool_calls !== undefined) {
    if (!Array.isArray(item.tool_calls)) {
      warn(
        warnings,
        'inject_invalid_messages',
        'inject',
        'inject tool_calls must be an array when present', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
      return undefined;
    }
    msg.tool_calls = item.tool_calls as TurnHistoryMessage['tool_calls'];
  }
  if (item.name !== undefined) {
    if (typeof item.name !== 'string') {
      warn(warnings, 'inject_invalid_messages', 'inject', 'inject name must be a string'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return undefined;
    }
    msg.name = item.name;
  }
  if (item.metadata !== undefined) {
    if (!isRecord(item.metadata)) {
      warn(warnings, 'inject_invalid_messages', 'inject', 'inject metadata must be a plain object'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return undefined;
    }
    msg.metadata = { ...item.metadata };
  }
  if (item.tool_call_id !== undefined) {
    warn(
      warnings,
      'inject_invalid_messages',
      'inject',
      'inject tool_call_id is rejected (not a tool-role message)', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }

  return msg;
}

function coerceHistoryMessages(
  raw: unknown,
  warnings: StageApplyWarning[],
): TurnHistoryMessage[] | undefined {
  if (!Array.isArray(raw)) {
    warn(
      warnings,
      'inject_invalid_messages',
      'inject',
      'inject must be an array of history messages', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
    return undefined;
  }
  const out: TurnHistoryMessage[] = [];
  for (const item of raw) {
    const msg = coerceInjectMessage(item, warnings);
    if (msg) out.push(msg);
  }
  return out.length > 0 ? out : undefined;
}

/** The inject's messages under its id; an unusable id refuses the inject whole. */
function injectUnit(
  result: Record<string, unknown>,
  warnings: StageApplyWarning[],
): InjectUnit | undefined {
  const messages = coerceHistoryMessages(result.inject, warnings);
  if (!messages) return undefined;
  if (result.injectId === undefined) return { messages };
  if (typeof result.injectId === 'string' && result.injectId.trim()) {
    return { id: result.injectId, messages };
  }
  warn(
    warnings,
    'inject_id_invalid',
    'injectId',
    'injectId must be a non-empty string; inject refused', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
  return undefined;
}

function applyInjectField(
  result: Record<string, unknown>,
  input: StageApplyInput,
  out: StageApplyOutput,
): void {
  if (!('inject' in result) || result.inject === undefined) {
    if (result.injectId !== undefined) {
      warn(out.warnings, 'inject_id_invalid', 'injectId', 'injectId without inject ignored'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    return;
  }
  const { stage, injectAllowed, injectWouldExceedMaxSteps } = input;
  if (!stageAllowsAffordance(stage, 'inject')) {
    warn(
      out.warnings,
      'affordance_not_allowed',
      'inject',
      `inject is not allowed at stage ${stage}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else if (!injectAllowed) {
    warn(
      out.warnings,
      'inject_not_allowed',
      'inject',
      'inject gate is closed for this profile/session', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else if (injectWouldExceedMaxSteps) {
    warn(
      out.warnings,
      'inject_rejected_max_steps',
      'inject',
      'inject rejected: another model step would exceed maxSteps', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else {
    const unit = injectUnit(result, out.warnings);
    if (unit) out.inject = unit;
  }
}

function applyAbortField(
  result: Record<string, unknown>,
  stage: TurnStage,
  out: StageApplyOutput,
): void {
  if (!('abort' in result) || result.abort === undefined) return;
  if (!stageAllowsAffordance(stage, 'abort')) {
    warn(out.warnings, 'affordance_not_allowed', 'abort', 'abort is not allowed at post_turn'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  } else if (result.abort === true) {
    out.abort = true;
  } else if (isRecord(result.abort)) {
    const reason =
      typeof result.abort.reason === 'string' && result.abort.reason.trim()
        ? result.abort.reason.trim()
        : undefined;
    out.abort = reason ? { reason } : true;
  } else if (result.abort !== false) {
    warn(out.warnings, 'abort_invalid', 'abort', 'abort must be boolean or { reason?: string }'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function applyDenyField(
  result: Record<string, unknown>,
  stage: TurnStage,
  out: StageApplyOutput,
): void {
  if (!('deny' in result) || result.deny === undefined) return;
  if (!stageAllowsAffordance(stage, 'deny')) {
    warn(out.warnings, 'affordance_not_allowed', 'deny', `deny is not allowed at stage ${stage}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  } else if (!isRecord(result.deny)) {
    warn(out.warnings, 'deny_invalid', 'deny', 'deny must be an object'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  } else {
    const code =
      typeof result.deny.code === 'string' && result.deny.code.trim()
        ? result.deny.code.trim()
        : 'not_authorized';
    const message =
      typeof result.deny.message === 'string' && result.deny.message.trim()
        ? result.deny.message.trim()
        : 'Tool execution not authorized'; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    out.deny = { code, message };
  }
}

function applyConfirmField(
  result: Record<string, unknown>,
  stage: TurnStage,
  out: StageApplyOutput,
): void {
  if (!('confirm' in result) || result.confirm === undefined) return;
  if (!stageAllowsAffordance(stage, 'confirm')) {
    warn(
      out.warnings,
      'affordance_not_allowed',
      'confirm',
      `confirm is not allowed at stage ${stage}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else if (result.confirm === true) {
    out.confirm = {};
  } else if (isRecord(result.confirm)) {
    const summary =
      typeof result.confirm.summary === 'string' && result.confirm.summary.trim()
        ? result.confirm.summary.trim()
        : undefined;
    out.confirm = summary ? { summary } : {};
  } else {
    warn(
      out.warnings,
      'confirm_invalid',
      'confirm',
      'confirm must be true or { summary?: string }', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

const MUTATE_SUBJECT = { pre_tool: 'input', post_tool: 'output' } as const satisfies Partial<
  Record<TurnStage, 'input' | 'output'>
>;

function mutateSubject(stage: TurnStage): 'input' | 'output' | undefined {
  return stage in MUTATE_SUBJECT ? MUTATE_SUBJECT[stage as keyof typeof MUTATE_SUBJECT] : undefined;
}

function applyMutateField(
  result: Record<string, unknown>,
  input: StageApplyInput,
  out: StageApplyOutput,
): void {
  const { stage } = input;
  if (!('mutate' in result) || result.mutate === undefined) return;
  if (!stageAllowsAffordance(stage, 'mutate')) {
    warn(
      out.warnings,
      'affordance_not_allowed',
      'mutate',
      `mutate is not allowed at stage ${stage}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
    return;
  }
  const subject = mutateSubject(stage);
  if (!subject) {
    // why: Matrix allows mutate but no subject is mapped: a kernel drift, surfaced not swallowed.
    warn(
      out.warnings,
      'mutate_invalid',
      'mutate',
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `no mutate subject is defined at stage ${stage}`,
    );
    return;
  }
  if (!isRecord(result.mutate) || result.mutate[subject] === undefined) {
    warn(
      out.warnings,
      'mutate_invalid',
      'mutate',
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `mutate must be { ${subject}: unknown } at stage ${stage}`,
    );
    return;
  }
  if (input.mutable === false) {
    warn(
      out.warnings,
      'mutate_invalid',
      'mutate',
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `there is no ${subject} to replace at this ${stage} fire`,
    );
    return;
  }
  out.mutate =
    subject === 'input' ? { input: result.mutate.input } : { output: result.mutate.output };
}

/** Never throws: invalid fields become warnings and are dropped. */
export function applyStageResult(input: StageApplyInput): StageApplyOutput {
  const warnings: StageApplyWarning[] = [];
  const out: StageApplyOutput = { warnings };
  const { stage, result } = input;

  if (result == null) return out;
  if (!isRecord(result)) {
    warn(warnings, 'result_invalid', 'result', 'StageResult must be a plain object'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return out;
  }

  for (const key of Object.keys(result)) {
    if (!STAGE_RESULT_KEYS.has(key)) {
      warn(warnings, 'unknown_field', key, `unknown StageResult field "${key}" ignored`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  }

  applyInjectField(result, input, out);
  applyAbortField(result, stage, out);
  applyDenyField(result, stage, out);
  applyConfirmField(result, stage, out);
  applyMutateField(result, input, out);

  if (out.deny && out.confirm) {
    warn(warnings, 'confirm_invalid', 'confirm', 'confirm ignored because deny is set'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    delete out.confirm;
  }

  return out;
}

/** What a `stage` event records beside the stage: the tool call, its gate and any injected messages. */
export type StageEventExtra = {
  callId?: string;
  toolName?: string;
  callNotStarted?: boolean;
  awaiting?: boolean;
  gate?: ToolGate;
  stop?: TurnStop;
  injected?: { id: string }[];
};

/** Build a stream `stage` event. Unknown extra keys are not copied. */
export function stageEventFields(
  stage: TurnStage,
  extra?: Partial<StageEventExtra>,
): TurnEventOf<'stage'> {
  const event: TurnEventOf<'stage'> = { type: 'stage', stage };
  if (!extra) return event;
  if (extra.callId !== undefined) event.callId = extra.callId;
  if (extra.toolName !== undefined) event.toolName = extra.toolName;
  if (extra.callNotStarted !== undefined) event.callNotStarted = extra.callNotStarted;
  if (extra.awaiting !== undefined) event.awaiting = extra.awaiting;
  if (extra.gate !== undefined) event.gate = extra.gate;
  if (extra.stop !== undefined) event.stop = extra.stop;
  if (extra.injected !== undefined) event.injected = extra.injected;
  return event;
}

export function injectMessages(units: readonly InjectUnit[]): TurnHistoryMessage[] {
  return units.flatMap((unit) => unit.messages);
}

/**
 * The `stage` event recording that `units` landed, naming the ones the host
 * named; `undefined` when none was named. Emit it where the messages land,
 * never before: an inject that never lands is never reported.
 */
export function injectedStageEvent(
  stage: TurnStage,
  units: readonly InjectUnit[],
  extra?: Pick<StageEventExtra, 'callId' | 'toolName'>,
): TurnEventOf<'stage'> | undefined {
  const injected = units.flatMap((unit) => (unit.id === undefined ? [] : [{ id: unit.id }]));
  if (injected.length === 0) return undefined;
  return stageEventFields(stage, { ...extra, injected });
}

export function injectWouldExceedMaxSteps(
  stepCount: number,
  maxSteps: number | undefined,
): boolean {
  if (maxSteps === undefined || maxSteps <= 0) return false;
  return stepCount >= maxSteps;
}

export interface RunStageArgs extends StageCallBag {
  stage: TurnStage;
  step: number;
  history: readonly TurnHistoryMessage[];
  /**
   * Handlers in call order. Later scalars win, `inject` lists concatenate. A
   * tool-local `preTool` result rides here as the first handler.
   */
  handlers: readonly StageHandler[];
  /** Profile guardrails — every inject site runs the untrusted sanitize path. */
  guardrails: Profile['guardrails'];
  injectAllowed: boolean;
  injectWouldExceedMaxSteps?: boolean;
  mutable?: boolean;
  host?: unknown;
  signal?: AbortSignal;
  span?: SpanHandle;
}

/** Applied stage output: every handler's inject, in call order, sanitized. */
export interface RunStageOutput extends Omit<StageApplyOutput, 'inject'> {
  inject: InjectUnit[];
}

function appliedAffordance(applied: RunStageOutput, key: StageAffordance): boolean {
  return key === 'inject' ? applied.inject.length > 0 : Boolean(applied[key]);
}

/**
 * Merge per-handler applied outputs in call order. Later scalars win, `inject`
 * lists concatenate, warnings accumulate. `deny` beats `confirm` across handlers
 * exactly as it does within one return.
 */
function mergeApplied(parts: readonly StageApplyOutput[]): RunStageOutput {
  const out: RunStageOutput = { warnings: parts.flatMap((part) => part.warnings), inject: [] };
  for (const part of parts) {
    if (part.abort !== undefined) out.abort = part.abort;
    if (part.deny) out.deny = part.deny;
    if (part.confirm) out.confirm = part.confirm;
    if (part.mutate) out.mutate = part.mutate;
    if (part.inject) out.inject.push(part.inject);
  }
  if (out.deny && out.confirm) {
    warn(out.warnings, 'confirm_invalid', 'confirm', 'confirm ignored because deny is set'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    delete out.confirm;
  }
  return out;
}

/**
 * Await each handler in order and apply its return on its own, so one handler's
 * junk is that handler's warning and cannot erase another's affordance. Each
 * handler gets its own shallow context; abort wins over any handler error.
 */
async function applyHandlers(
  handlers: readonly StageHandler[],
  ctx: StageContext,
  apply: Omit<StageApplyInput, 'result'>,
  signal?: AbortSignal,
): Promise<StageApplyOutput[]> {
  const parts: StageApplyOutput[] = [];
  for (const handler of handlers) {
    let raw: unknown;
    try {
      raw = await handler({ ...ctx });
    } catch (err) {
      throwIfAborted(signal);
      throw err;
    }
    throwIfAborted(signal);
    parts.push(applyStageResult({ ...apply, result: raw }));
  }
  return parts;
}

/** Stage events always emit, even with no handlers. */
export async function* runStage(args: RunStageArgs): AsyncGenerator<TurnEvent, RunStageOutput> {
  const {
    stage,
    step,
    history,
    handlers,
    guardrails,
    injectAllowed,
    injectWouldExceedMaxSteps,
    mutable,
    host,
    signal,
    span,
    ...bag
  } = args;
  throwIfAborted(signal);

  // why: Stream stage events stay lean (no outputRaw/failure). Hosts read those on
  // StageContext via onStage; tool failures also ride tool events.
  yield stageEventFields(stage, {
    callId: bag.callId,
    toolName: bag.tool,
    callNotStarted: bag.callNotStarted,
    awaiting: bag.awaiting,
    gate: bag.gate,
    stop: bag.stop,
  });

  if (handlers.length === 0) {
    span?.event('theorem.stage', { stage, affordance: [] });
    return { warnings: [], inject: [] };
  }

  const ctx: StageContext = { stage, step, history, host, ...bag };
  const startedMs = span?.msSinceStart();
  const applied = mergeApplied(
    await applyHandlers(
      handlers,
      ctx,
      { stage, injectAllowed, injectWouldExceedMaxSteps, mutable },
      signal,
    ),
  );
  span?.event('theorem.stage', {
    stage,
    ...(startedMs === undefined ? {} : { hook_ms: span.msSinceStart() - startedMs }),
    affordance: STAGE_AFFORDANCES.filter((key) => appliedAffordance(applied, key)),
    ...(applied.warnings.length > 0 ? { warnings: applied.warnings.map((w) => w.code) } : {}),
  });

  if (applied.warnings.length > 0) {
    yield {
      ...stageEventFields(stage, { callId: bag.callId, toolName: bag.tool }),
      stageWarnings: applied.warnings,
    };
  }

  if (applied.inject.length === 0) return applied;
  const hits: GuardrailHit[] = [];
  const detection = detectionForTrust(resolveGuardrailPolicy(guardrails), 'untrusted');
  const sanitized = applied.inject.map((unit) => ({
    ...unit,
    messages: sanitizeHistory(unit.messages, detection, hits),
  }));
  const redacted = guardrailFromHits('history', 'untrusted', hits, 'redact');
  if (redacted?.guardrail)
    span?.event('theorem.guardrail', guardrailAttributes(redacted.guardrail));
  if (redacted) yield redacted;
  return { ...applied, inject: sanitized };
}
