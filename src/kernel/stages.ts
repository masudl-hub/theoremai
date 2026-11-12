import { boundaryReader, detectEvent } from '../guardrails/detect-at.ts';
import { throwIfAborted } from '../guardrails/error.ts';
import { guardrailTurnEvent } from '../guardrails/events.ts';
import { resolveGuardrailPolicy } from '../guardrails/policy.ts';
import { requestRefused, sanitizeHistory } from '../guardrails/sanitize.ts';
import type { SpanHandle } from '../observability/trace-span.ts';
import { guardrailAttributes } from './engine/turn-trace.ts';
import { hookFailed } from './hook-failure.ts';
import { jsonValueSchema } from './json.ts';
import type { StageApplyWarningCode, TurnStage } from './schema.ts';
import type { TurnStop } from './stop.ts';
import type { ModelToolResult, ToolFailure, ToolGate } from './tools/types.ts';
import type {
  AwaitingUserInput,
  InjectedMessages,
  StageApplyWarning,
  TurnEventOf,
} from './turn-events.ts';
import type { Profile, ToolId, TurnEvent, TurnHistoryMessage } from './types.ts';
import { isRecord } from './util/record.ts';

export type { AwaitingUserInput, ToolGate };

/**
 * What a stage handler can ask for: inject messages, abort, deny a tool call, ask for
 * confirmation, mutate it, label it failed, have it wait for other calls in its step, or end
 * the turn once its step's calls settle.
 */
export const STAGE_AFFORDANCES = [
  'inject',
  'abort',
  'deny',
  'confirm',
  'mutate',
  'labelFailed',
  'waitFor',
  'end',
] as const;
/** One of {@linkcode STAGE_AFFORDANCES}. */
export type StageAffordance = (typeof STAGE_AFFORDANCES)[number];

/** Inject still needs the inject gate at apply time. Empty = observe only. */
export const STAGE_AFFORDANCE_MATRIX: Readonly<Record<TurnStage, readonly StageAffordance[]>> =
  Object.freeze({
    pre_turn: Object.freeze(['inject', 'abort'] as const),
    pre_tool: Object.freeze(['abort', 'deny', 'confirm', 'mutate', 'waitFor'] as const),
    post_tool: Object.freeze(['inject', 'abort', 'deny', 'mutate', 'labelFailed', 'end'] as const),
    before_end: Object.freeze(['inject', 'abort'] as const),
    post_turn: Object.freeze([] as const),
  });

const STAGE_RESULT_KEYS = new Set<string>([
  ...STAGE_AFFORDANCES,
  'injectId',
  'released',
  'promote',
]);

/** A call the model made in this step, as the host was shown it. */
export interface StepCall {
  callId: string;
  tool: string;
  input: unknown;
}

export type StageCallBag = {
  callId?: string;
  tool?: string;
  input?: unknown;
  /** `pre_tool` in a turn's step: every call the model made in the step, in the order it made them. */
  stepCalls?: readonly StepCall[];
  /**
   * `pre_tool`: the user approved this call where it stopped, at its permission or a
   * confirmation. A sign-in is not an approval.
   */
  approved?: true;
  callNotStarted?: boolean;
  outputRaw?: unknown;
  /**
   * `post_tool`: the output as the model reads it, before it becomes text: `outputRaw` without
   * the fields its schema marks `exposeToModel: false`. Absent when the call failed or the tool
   * is hidden from the model.
   */
  outputForModel?: unknown;
  outputModel?: ModelToolResult;
  /** `post_tool`: the tool's past activity label, filled from the input and `outputRaw`. */
  activityPast?: string;
  /** `post_tool`: the tool's failed activity label, filled from the input. */
  activityFailed?: string;
  failure?: ToolFailure;
  awaiting?: boolean;
  stop?: TurnStop;
  gate?: ToolGate;
  /**
   * `before_end` on text: the answer the model just wrote, before any guardrail verdict on it and
   * not yet in `history`. Its last step wrote no text when no message here carries any.
   */
  reply?: readonly TurnHistoryMessage[];
};

/** What a stage handler is given: the stage, the step, and what has happened so far. */
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
  /**
   * With `inject`, at `post_tool` or `before_end`: how many characters of the attempt's reply text,
   * as the turn gave it, the user already has. The rest is a draft they never got: it leaves the
   * turn's history and its reply when the inject lands, so the model answers everything afresh
   * after the part they have. Left out, they have all of it.
   */
  released?: number;
  /**
   * With `inject`: tools the model may call once the inject lands. Only a tool the turn could load
   * goes on its list (`loadTier: 'T2'`, among the turn's gated tools); any other id is left out.
   */
  promote?: ToolId[];
  abort?: boolean | { reason?: string };
  /**
   * `pre_tool`: refuse the call. `post_tool`: replace the result with this failure.
   * `details`, a JSON object, become `failure.details`: the model reads them, and the guardrails
   * read them first. Details that are not a JSON object are a `deny_invalid` warning, and the call
   * is still refused, without details.
   */
  deny?: { code?: string; message?: string; details?: Record<string, unknown> };
  /** `pre_tool` only — request a confirm/permission gate. */
  confirm?: true | { summary?: string };
  /**
   * Rewrites what the call has at this stage.
   * - `pre_tool`: `{ input }` replaces the call input, which is validated again.
   * - `post_tool` on a completed call: `{ output }` replaces the raw output, which is validated
   *   again.
   * - `post_tool` on a failed call: `{ details }` replaces `failure.details`, a JSON object. The
   *   code, kind and message stay. To keep the old details, spread `ctx.failure.details` into the
   *   new ones. The model reads the new details, and the guardrails read them first.
   *
   * Any other key at a fire is a `mutate_invalid` warning, and nothing changes.
   */
  mutate?: StageMutate;
  /**
   * `post_tool` only: the call completed, but show its failed label (`activityFailed`) on the
   * terminal `tool` event. The result and the phase stay as they are.
   */
  labelFailed?: true;
  /**
   * `pre_tool` only: the call ids in `stepCalls` whose calls must settle before this call's body
   * starts. A call held for confirmation is held at once and does not wait.
   */
  waitFor?: string[];
  /**
   * `post_tool` on a text turn only: the turn ends once every call of this step has settled. The
   * model takes no further step, `before_end` does not run, and `done` stops as `completed`. The
   * reply is what the model wrote before its calls, possibly empty, and still passes its checks: a
   * refused reply is retried like any other, as a new step `end` no longer holds.
   */
  end?: true;
}

/** A rewrite of a tool call's input, its output, or its failure's details. */
export type StageMutate =
  | { input: unknown }
  | { output: unknown }
  | { details: Record<string, unknown> };

/**
 * What `mutate` rewrites at one stage fire: a `pre_tool` call's `input`, a completed call's
 * `output`, or a failed call's `details`.
 */
export type StageMutateSubject = 'input' | 'output' | 'details';

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
   * What `mutate` rewrites at this fire. Absent when there is nothing to rewrite (a call whose
   * output the kernel owns): `mutate` is then a `mutate_invalid` warning, never a silent no-op.
   */
  mutates?: StageMutateSubject;
  /** True on a text turn's tool step, the only place `end` has a turn to end. */
  endAllowed?: boolean;
}

export interface InjectUnit {
  id?: string;
  messages: TurnHistoryMessage[];
  /** {@linkcode StageResult.released}: the reply text the user has when this inject lands. */
  released?: number;
  /** {@linkcode StageResult.promote}: the tools the model may call once this inject lands. */
  promote?: ToolId[];
}

/** A stage handler's result after validation: the parts the turn will act on. */
export interface StageApplyOutput {
  inject?: InjectUnit;
  abort?: boolean | { reason?: string };
  deny?: { code: string; message: string; details?: Record<string, unknown> };
  confirm?: { summary?: string };
  mutate?: StageMutate;
  labelFailed?: true;
  waitFor?: string[];
  end?: true;
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

/** Drops unknown keys and rejects `role: 'tool'`; sanitizeHistory runs at the inject site. */
function coerceInjectMessage(
  item: unknown,
  warnings: StageApplyWarning[],
): TurnHistoryMessage | undefined {
  if (!isRecord(item)) {
    warn(warnings, 'inject_invalid_messages', 'inject', 'inject entry must be an object'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return undefined;
  }
  if (item.role === 'tool') {
    warn(
      warnings,
      'inject_invalid_messages',
      'inject',
      'inject messages with role "tool" are rejected', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
    return undefined;
  }
  if (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system') {
    warn(
      warnings,
      'inject_invalid_messages',
      'inject',
      `inject role not allowed: ${String(item.role)}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
        'inject content must be a string when present', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
        'inject parts must be an array when present', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
        'inject tool_calls must be an array when present', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
      return undefined;
    }
    msg.tool_calls = item.tool_calls as TurnHistoryMessage['tool_calls'];
  }
  if (item.name !== undefined) {
    if (typeof item.name !== 'string') {
      warn(warnings, 'inject_invalid_messages', 'inject', 'inject name must be a string'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return undefined;
    }
    msg.name = item.name;
  }
  if (item.metadata !== undefined) {
    if (!isRecord(item.metadata)) {
      warn(warnings, 'inject_invalid_messages', 'inject', 'inject metadata must be a plain object'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return undefined;
    }
    msg.metadata = { ...item.metadata };
  }
  if (item.tool_call_id !== undefined) {
    warn(
      warnings,
      'inject_invalid_messages',
      'inject',
      'inject tool_call_id is rejected (not a tool-role message)', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
      'inject must be an array of history messages', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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

/** `released` as a count of characters; anything else is a warning, and the user has the whole reply. */
function injectReleased(raw: unknown, warnings: StageApplyWarning[]): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  warn(
    warnings,
    'inject_released_invalid',
    'released',
    'released must be a whole number of characters, 0 or more; ignored', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
  return undefined;
}

/** `promote` as a list of tool ids; anything else is a warning, and no tool is promoted. */
function injectPromote(raw: unknown, warnings: StageApplyWarning[]): ToolId[] | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) && raw.every((id) => typeof id === 'string' && id.trim() !== '')) {
    return raw;
  }
  warn(
    warnings,
    'inject_promote_invalid',
    'promote',
    'promote must be a list of tool ids; ignored', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
  return undefined;
}

/** The inject's messages under its id; an unusable id refuses the inject whole. */
function injectUnit(
  result: Record<string, unknown>,
  warnings: StageApplyWarning[],
): InjectUnit | undefined {
  const messages = coerceHistoryMessages(result.inject, warnings);
  if (!messages) return undefined;
  const released = injectReleased(result.released, warnings);
  const promote = injectPromote(result.promote, warnings);
  const unit: InjectUnit = {
    messages,
    ...(released === undefined ? {} : { released }),
    ...(promote === undefined ? {} : { promote }),
  };
  if (result.injectId === undefined) return unit;
  if (typeof result.injectId === 'string' && result.injectId.trim()) {
    return { id: result.injectId, ...unit };
  }
  warn(
    warnings,
    'inject_id_invalid',
    'injectId',
    'injectId must be a non-empty string; inject refused', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
      warn(out.warnings, 'inject_id_invalid', 'injectId', 'injectId without inject ignored'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    if (result.released !== undefined) {
      warn(out.warnings, 'inject_released_invalid', 'released', 'released without inject ignored'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    if (result.promote !== undefined) {
      warn(out.warnings, 'inject_promote_invalid', 'promote', 'promote without inject ignored'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    return;
  }
  const { stage, injectAllowed, injectWouldExceedMaxSteps } = input;
  if (!stageAllowsAffordance(stage, 'inject')) {
    warn(
      out.warnings,
      'affordance_not_allowed',
      'inject',
      `inject is not allowed at stage ${stage}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else if (!injectAllowed) {
    warn(
      out.warnings,
      'inject_not_allowed',
      'inject',
      'inject gate is closed for this profile/session', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else if (injectWouldExceedMaxSteps) {
    warn(
      out.warnings,
      'inject_rejected_max_steps',
      'inject',
      'inject rejected: another model step would exceed maxSteps', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
    warn(out.warnings, 'affordance_not_allowed', 'abort', 'abort is not allowed at post_turn'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  } else if (result.abort === true) {
    out.abort = true;
  } else if (isRecord(result.abort)) {
    const reason =
      typeof result.abort.reason === 'string' && result.abort.reason.trim()
        ? result.abort.reason.trim()
        : undefined;
    out.abort = reason ? { reason } : true;
  } else if (result.abort !== false) {
    warn(out.warnings, 'abort_invalid', 'abort', 'abort must be boolean or { reason?: string }'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function applyDenyField(
  result: Record<string, unknown>,
  stage: TurnStage,
  out: StageApplyOutput,
): void {
  if (!('deny' in result) || result.deny === undefined) return;
  if (!stageAllowsAffordance(stage, 'deny')) {
    warn(out.warnings, 'affordance_not_allowed', 'deny', `deny is not allowed at stage ${stage}`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  } else if (!isRecord(result.deny)) {
    warn(out.warnings, 'deny_invalid', 'deny', 'deny must be an object'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  } else {
    const code =
      typeof result.deny.code === 'string' && result.deny.code.trim()
        ? result.deny.code.trim()
        : 'not_authorized';
    const message =
      typeof result.deny.message === 'string' && result.deny.message.trim()
        ? result.deny.message.trim()
        : 'Tool execution not authorized'; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    const details = result.deny.details;
    if (details === undefined) {
      out.deny = { code, message };
    } else if (isRecord(details) && jsonValueSchema.safeParse(details).success) {
      out.deny = { code, message, details };
    } else {
      // why: A refusal stands even when its details are bad; only the details are dropped.
      out.deny = { code, message };
      // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      warn(out.warnings, 'deny_invalid', 'deny', 'deny.details must be a JSON object');
    }
  }
}

function applyLabelFailedField(
  result: Record<string, unknown>,
  stage: TurnStage,
  out: StageApplyOutput,
): void {
  if (!('labelFailed' in result) || result.labelFailed === undefined) return;
  if (!stageAllowsAffordance(stage, 'labelFailed')) {
    warn(
      out.warnings,
      'affordance_not_allowed',
      'labelFailed',
      `labelFailed is not allowed at stage ${stage}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else if (result.labelFailed === true) {
    out.labelFailed = true;
  } else if (result.labelFailed !== false) {
    warn(out.warnings, 'label_failed_invalid', 'labelFailed', 'labelFailed must be true'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
      `confirm is not allowed at stage ${stage}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
      'confirm must be true or { summary?: string }', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function applyWaitForField(
  result: Record<string, unknown>,
  stage: TurnStage,
  out: StageApplyOutput,
): void {
  if (!('waitFor' in result) || result.waitFor === undefined) return;
  if (!stageAllowsAffordance(stage, 'waitFor')) {
    warn(
      out.warnings,
      'affordance_not_allowed',
      'waitFor',
      `waitFor is not allowed at stage ${stage}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else if (
    !Array.isArray(result.waitFor) ||
    !result.waitFor.every((id): id is string => typeof id === 'string' && id.trim() !== '')
  ) {
    warn(
      out.warnings,
      'wait_for_invalid',
      'waitFor',
      'waitFor must be an array of call ids', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else if (result.waitFor.length > 0) {
    out.waitFor = [...new Set(result.waitFor)];
  }
}

function applyEndField(
  result: Record<string, unknown>,
  input: StageApplyInput,
  out: StageApplyOutput,
): void {
  if (!('end' in result) || result.end === undefined) return;
  if (!stageAllowsAffordance(input.stage, 'end')) {
    warn(
      out.warnings,
      'affordance_not_allowed',
      'end',
      `end is not allowed at stage ${input.stage}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else if (result.end !== true) {
    warn(out.warnings, 'end_invalid', 'end', 'end must be true'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  } else if (!input.endAllowed) {
    warn(
      out.warnings,
      'end_not_allowed',
      'end',
      "end is ignored outside a text turn's tool step", // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  } else {
    out.end = true;
  }
}

/** Why a `post_tool` fire takes only `subject`, for a warning that says so. */
const MUTATE_FIRE = { input: '', output: ': the call completed', details: ': the call failed' }; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)

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
      `mutate is not allowed at stage ${stage}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
    return;
  }
  const subject = input.mutates;
  if (!subject) {
    warn(
      out.warnings,
      'mutate_invalid',
      'mutate',
      // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `there is nothing to replace at this ${stage} fire`,
    );
    return;
  }
  const mutate = result.mutate;
  if (!isRecord(mutate) || mutate[subject] === undefined) {
    const shape = subject === 'details' ? '{ details: { … } }' : `{ ${subject}: unknown }`;
    warn(
      out.warnings,
      'mutate_invalid',
      'mutate',
      // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `mutate must be ${shape} at this ${stage} fire${MUTATE_FIRE[subject]}`,
    );
    return;
  }
  if (subject === 'details') {
    const details = mutate.details;
    if (!isRecord(details) || !jsonValueSchema.safeParse(details).success) {
      warn(
        out.warnings,
        'mutate_invalid',
        'mutate',
        // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        'mutate.details must be a JSON object',
      );
      return;
    }
    out.mutate = { details };
    return;
  }
  out.mutate = subject === 'input' ? { input: mutate.input } : { output: mutate.output };
}

/** Never throws: invalid fields become warnings and are dropped. */
export function applyStageResult(input: StageApplyInput): StageApplyOutput {
  const warnings: StageApplyWarning[] = [];
  const out: StageApplyOutput = { warnings };
  const { stage, result } = input;

  if (result == null) return out;
  if (!isRecord(result)) {
    warn(warnings, 'result_invalid', 'result', 'StageResult must be a plain object'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return out;
  }

  for (const key of Object.keys(result)) {
    if (!STAGE_RESULT_KEYS.has(key)) {
      warn(warnings, 'unknown_field', key, `unknown StageResult field "${key}" ignored`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  }

  applyInjectField(result, input, out);
  applyAbortField(result, stage, out);
  applyDenyField(result, stage, out);
  applyConfirmField(result, stage, out);
  applyMutateField(result, input, out);
  applyLabelFailedField(result, stage, out);
  applyWaitForField(result, stage, out);
  applyEndField(result, input, out);

  if (out.deny && out.confirm) {
    warn(warnings, 'confirm_invalid', 'confirm', 'confirm ignored because deny is set'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    delete out.confirm;
  }

  return out;
}

/** What a `stage` event records beside the stage: the tool call, its gate, and any injected messages. */
export type StageEventExtra = {
  callId?: string;
  toolName?: string;
  callNotStarted?: boolean;
  awaiting?: boolean;
  gate?: ToolGate;
  stop?: TurnStop;
  injected?: InjectedMessages[];
  released?: number;
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
  if (extra.released !== undefined) event.released = extra.released;
  return event;
}

export function injectMessages(units: readonly InjectUnit[]): TurnHistoryMessage[] {
  return units.flatMap((unit) => unit.messages);
}

/**
 * The `stage` event recording that `units` landed, naming the ones the host
 * named with the messages they put in the conversation, and the reply text the user has when they dropped a draft (`released`);
 * `undefined` when there is neither. Emit it where the messages land, never
 * before: an inject that never lands is never reported.
 */
export function injectedStageEvent(
  stage: TurnStage,
  units: readonly InjectUnit[],
  extra?: Pick<StageEventExtra, 'callId' | 'toolName' | 'released'>,
): TurnEventOf<'stage'> | undefined {
  const injected = units.flatMap((unit) =>
    unit.id === undefined ? [] : [{ id: unit.id, messages: unit.messages }],
  );
  if (injected.length === 0 && extra?.released === undefined) return undefined;
  return stageEventFields(stage, { ...extra, ...(injected.length > 0 ? { injected } : {}) });
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
  mutates?: StageMutateSubject;
  endAllowed?: boolean;
  host?: unknown;
  signal?: AbortSignal;
  span?: SpanHandle;
}

/** Applied stage output: every handler's inject, in call order, sanitized. */
export interface RunStageOutput extends Omit<StageApplyOutput, 'inject'> {
  inject: InjectUnit[];
  /** At `pre_tool`, what a handler threw: the call fails with it, and no other handler runs. */
  crashed?: { error: unknown };
}

function appliedAffordance(applied: RunStageOutput, key: StageAffordance): boolean {
  return key === 'inject' ? applied.inject.length > 0 : Boolean(applied[key]);
}

/**
 * Merge per-handler applied outputs in call order. Later scalars win, `inject`
 * lists concatenate, `waitFor` ids join, warnings accumulate. `deny` beats `confirm`
 * across handlers exactly as it does within one return.
 */
function mergeApplied(parts: readonly StageApplyOutput[]): RunStageOutput {
  const out: RunStageOutput = { warnings: parts.flatMap((part) => part.warnings), inject: [] };
  for (const part of parts) {
    if (part.abort !== undefined) out.abort = part.abort;
    if (part.deny) out.deny = part.deny;
    if (part.confirm) out.confirm = part.confirm;
    if (part.mutate) out.mutate = part.mutate;
    if (part.labelFailed) out.labelFailed = true;
    if (part.waitFor) out.waitFor = [...new Set([...(out.waitFor ?? []), ...part.waitFor])];
    if (part.end) out.end = true;
    if (part.inject) out.inject.push(part.inject);
  }
  if (out.deny && out.confirm) {
    warn(out.warnings, 'confirm_invalid', 'confirm', 'confirm ignored because deny is set'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    delete out.confirm;
  }
  return out;
}

/**
 * Await each handler in order and apply its return on its own, so one handler's
 * junk is that handler's warning and cannot erase another's affordance. Each
 * handler gets its own shallow context; abort wins over any handler error. A
 * handler that throws adds nothing; at `pre_tool` it ends the run, since the
 * call cannot go on unapproved.
 */
async function applyHandlers(
  handlers: readonly StageHandler[],
  ctx: StageContext,
  apply: Omit<StageApplyInput, 'result'>,
  signal?: AbortSignal,
): Promise<{ parts: StageApplyOutput[]; crashes: unknown[] }> {
  const parts: StageApplyOutput[] = [];
  const crashes: unknown[] = [];
  for (const handler of handlers) {
    let raw: unknown;
    try {
      raw = await handler({ ...ctx });
    } catch (err) {
      throwIfAborted(signal);
      crashes.push(err);
      if (apply.stage === 'pre_tool') break;
      continue;
    }
    throwIfAborted(signal);
    parts.push(applyStageResult({ ...apply, result: raw }));
  }
  return { parts, crashes };
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
    mutates,
    endAllowed,
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
  const { parts, crashes } = await applyHandlers(
    handlers,
    ctx,
    {
      stage,
      injectAllowed,
      injectWouldExceedMaxSteps,
      ...(mutates ? { mutates } : {}),
      endAllowed,
    },
    signal,
  );
  if (stage === 'pre_tool' && crashes.length > 0) {
    span?.event('theorem.stage', { stage, affordance: [] });
    return { warnings: [], inject: [], crashed: { error: crashes[0] } };
  }
  for (const err of crashes) {
    yield hookFailed('onStage', err, {
      stage,
      ...(bag.callId === undefined ? {} : { callId: bag.callId }),
      span,
    });
  }
  const applied = mergeApplied(parts);
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
  return { ...applied, inject: yield* sanitizeInjects(applied.inject, guardrails, span) };
}

/**
 * `units` as the profile's guardrails let them into the conversation. What they find is reported
 * once; a block refuses the turn.
 */
export function* sanitizeInjects(
  units: readonly InjectUnit[],
  guardrails: Profile['guardrails'],
  span?: SpanHandle,
): Generator<TurnEvent, InjectUnit[]> {
  const reader = boundaryReader('injected', resolveGuardrailPolicy(guardrails).detect);
  const sanitized = units.map((unit) => ({
    ...unit,
    messages: sanitizeHistory(unit.messages, reader),
  }));
  const found = reader.found();
  const event = detectEvent('injected', found);
  if (event) {
    span?.event('theorem.guardrail', guardrailAttributes(event));
    yield guardrailTurnEvent(event);
  }
  if (found.action === 'block') throw requestRefused('injected');
  return sanitized;
}
