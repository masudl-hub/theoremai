/**
 * Turn stages: frozen shapes, defensive affordance application, and the one
 * spine every stage runs through (`runStage`).
 *
 * Contract: `docs/contracts/stages.md`. Text `runTurn`, live `runSession`, and
 * tool execute differ only in what they do with a stage's output — history
 * append, live text ingress, or a tool gate — never in how the stage runs.
 *
 * @module
 */

import { throwIfAborted } from '../guardrails/error.ts';
import { guardrailFromHits } from '../guardrails/events.ts';
import { detectionForTrust, resolveGuardrailPolicy } from '../guardrails/policy.ts';
import { sanitizeHistory } from '../guardrails/sanitize.ts';
import type { GuardrailHit } from '../guardrails/types.ts';
import {
  AWAITING_USER_INPUT_KINDS,
  AWAITING_USER_INPUT_STATUS,
  type AwaitingUserInputKind,
  isToolGateKind,
  TOOL_PERMISSION,
  type ToolPermission,
  type TurnStage,
} from './schema.ts';
import type { TurnStop } from './stop.ts';
import type { ModelToolResult, ToolFailure, ToolGate } from './tools/types.ts';
import type { Profile, TurnEvent, TurnHistoryMessage } from './types.ts';

/** Canonical homes: schema (`TurnStage`, `ToolGateKind`), tools/types (`ToolGate`). */
export type { AwaitingUserInputKind, ToolGate };

const AWAITING_KIND_SET = new Set<string>(AWAITING_USER_INPUT_KINDS);
const PERMISSION_SET = new Set<string>(TOOL_PERMISSION);

/** Closed set of kernel-applied stage affordances. */
export const STAGE_AFFORDANCES = ['inject', 'abort', 'deny', 'confirm', 'mutate'] as const;
export type StageAffordance = (typeof STAGE_AFFORDANCES)[number];

/**
 * Physical affordance matrix from `docs/contracts/stages.md`.
 * Inject still requires `injectAllowed` / `profileAllowsInject` at apply time.
 * Empty list = observe only.
 */
export const STAGE_AFFORDANCE_MATRIX: Readonly<Record<TurnStage, readonly StageAffordance[]>> =
  Object.freeze({
    pre_turn: Object.freeze(['inject', 'abort'] as const),
    pre_tool: Object.freeze(['abort', 'deny', 'confirm', 'mutate'] as const),
    post_tool: Object.freeze(['inject', 'abort', 'deny', 'mutate'] as const),
    before_end: Object.freeze(['inject', 'abort'] as const),
    post_turn: Object.freeze([] as const),
  });

const STAGE_RESULT_KEYS = new Set<string>(STAGE_AFFORDANCES);

/** Frozen awaiting completion payload (`docs/contracts/stages.md`). */
export interface AwaitingUserInput {
  status: typeof AWAITING_USER_INPUT_STATUS;
  kind: AwaitingUserInputKind;
  prompt: string;
  options?: string[];
}

/** Tool/stop fields shared by text + live stage apply argument bags. */
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

/** Context passed to `onStage`. */
export interface StageContext extends StageCallBag {
  stage: TurnStage;
  /** 1-based provider step (text) or utterance cycle index (live). */
  step: number;
  history: readonly TurnHistoryMessage[];
  /** Opaque host slot — never traced or client-forwarded by the kernel. */
  host?: unknown;
}

/** Host return from `onStage`. */
export interface StageResult {
  inject?: TurnHistoryMessage[];
  abort?: boolean | { reason?: string };
  /** `pre_tool`: refuse the call. `post_tool`: replace the result with this failure. */
  deny?: { code?: string; message?: string };
  /** `pre_tool` only — request a confirm/permission gate. */
  confirm?: true | { summary?: string };
  /** `pre_tool`: replace the call input. `post_tool`: replace the raw output. Both re-validate. */
  mutate?: StageMutate;
}

/** What `mutate` replaces: the stage's subject. */
export type StageMutate = { input: unknown } | { output: unknown };

export type StageHandler = (
  ctx: StageContext,
) => StageResult | undefined | Promise<StageResult | undefined>;

export type StageApplyWarningCode =
  | 'affordance_not_allowed'
  | 'inject_not_allowed'
  | 'inject_rejected_max_steps'
  | 'inject_invalid_messages'
  | 'deny_invalid'
  | 'confirm_invalid'
  | 'mutate_invalid'
  | 'abort_invalid'
  | 'unknown_field'
  | 'result_invalid';

export interface StageApplyWarning {
  code: StageApplyWarningCode;
  message: string;
  field: string;
}

export interface StageApplyInput {
  stage: TurnStage;
  /** Host return — treated as untrusted (`unknown` at the boundary). */
  result: unknown;
  /** Profile/session inject gate (`profileAllowsInject` / shipping `allowSteering`). */
  injectAllowed: boolean;
  /** When true, another provider step would exceed `maxSteps`. */
  injectWouldExceedMaxSteps?: boolean;
  /**
   * False when the stage's mutate subject is absent at this fire (a `post_tool`
   * whose body never completed, or a tool whose output the kernel must own).
   * `mutate` is then a `mutate_invalid` warning, never a silent no-op.
   */
  mutable?: boolean;
}

export interface StageApplyOutput {
  inject?: TurnHistoryMessage[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function warn(
  warnings: StageApplyWarning[],
  code: StageApplyWarningCode,
  field: string,
  message: string,
): void {
  warnings.push({ code, field, message });
}

/**
 * Parse tool output as awaiting-user-input. Returns undefined when the shape
 * is absent or invalid (does not throw — callers treat as normal output).
 */
export function parseAwaitingUserInput(output: unknown): AwaitingUserInput | undefined {
  if (!isRecord(output)) return undefined;
  if (output.status !== AWAITING_USER_INPUT_STATUS) return undefined;
  if (typeof output.kind !== 'string' || !AWAITING_KIND_SET.has(output.kind)) {
    return undefined;
  }
  if (typeof output.prompt !== 'string') return undefined;
  const prompt = output.prompt.trim();
  if (!prompt) return undefined;

  let options: string[] | undefined;
  if (output.options !== undefined) {
    if (!Array.isArray(output.options)) return undefined;
    options = [];
    for (const item of output.options) {
      if (typeof item !== 'string') return undefined;
      const trimmed = item.trim();
      if (!trimmed) return undefined;
      options.push(trimmed);
    }
    if (output.kind === 'choice' && options.length === 0) return undefined;
  } else if (output.kind === 'choice') {
    return undefined;
  }

  const parsed: AwaitingUserInput = {
    status: AWAITING_USER_INPUT_STATUS,
    kind: output.kind as AwaitingUserInputKind,
    prompt,
  };
  if (options) parsed.options = options;
  return parsed;
}

/** True when output is a valid awaiting completion. */
export function isAwaitingUserInput(output: unknown): output is AwaitingUserInput {
  return parseAwaitingUserInput(output) !== undefined;
}

function parseAuthChallenge(value: unknown): NonNullable<ToolGate['authChallenge']> | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.slot !== 'string' || !value.slot.trim()) return undefined;
  if (value.authType !== 'bearer' && value.authType !== 'api_key' && value.authType !== 'oauth2') {
    return undefined;
  }
  if (typeof value.message !== 'string' || !value.message.trim()) return undefined;
  const authChallenge: NonNullable<ToolGate['authChallenge']> = {
    slot: value.slot.trim(),
    authType: value.authType,
    message: value.message.trim(),
  };
  if (typeof value.authorizationUrl === 'string') {
    authChallenge.authorizationUrl = value.authorizationUrl;
  }
  if (typeof value.state === 'string') authChallenge.state = value.state;
  if (typeof value.issuer === 'string') authChallenge.issuer = value.issuer;
  if (typeof value.resource === 'string') authChallenge.resource = value.resource;
  if (Array.isArray(value.requiredScopes)) {
    const scopes: string[] = [];
    for (const s of value.requiredScopes) {
      if (typeof s === 'string' && s.trim()) scopes.push(s.trim());
    }
    if (scopes.length > 0) authChallenge.requiredScopes = scopes;
  }
  return authChallenge;
}

/**
 * Normalize / validate a host `ToolGate`. Returns undefined when invalid
 * (defensive — never throws into the runner).
 */
export function parseToolGate(value: unknown, fallbackTool = ''): ToolGate | undefined {
  if (!isRecord(value)) return undefined;
  if (!isToolGateKind(value.kind)) return undefined;
  const tool =
    typeof value.tool === 'string' && value.tool.trim() ? value.tool.trim() : fallbackTool.trim();
  if (!tool) return undefined;

  const gate: ToolGate = { kind: value.kind, tool };
  if (typeof value.summary === 'string' && value.summary.trim()) {
    gate.summary = value.summary.trim();
  }
  if (typeof value.permission === 'string' && PERMISSION_SET.has(value.permission)) {
    gate.permission = value.permission as ToolPermission;
  }
  if (value.kind === 'auth') {
    const authChallenge = parseAuthChallenge(value.authChallenge);
    if (!authChallenge) return undefined;
    gate.authChallenge = authChallenge;
  }
  return gate;
}

/**
 * Whitelist-copy one inject history message. Drops unknown keys and rejects
 * `role: 'tool'`. Does not run sanitizeHistory — that stays at the inject site.
 */
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

function applyInjectField(
  result: Record<string, unknown>,
  input: StageApplyInput,
  out: StageApplyOutput,
): void {
  if (!('inject' in result) || result.inject === undefined) return;
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
    const messages = coerceHistoryMessages(result.inject, out.warnings);
    if (messages) out.inject = messages;
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

/** The subject `mutate` replaces at each stage that allows it. */
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
    // Matrix allows mutate but no subject is mapped: a kernel drift, surfaced not swallowed.
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

/**
 * Defensively apply a host stage return against the affordance matrix.
 * Never throws. Invalid fields become warnings and are dropped.
 */
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

  // confirm + deny together: deny wins
  if (out.deny && out.confirm) {
    warn(warnings, 'confirm_invalid', 'confirm', 'confirm ignored because deny is set'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    delete out.confirm;
  }

  return out;
}

export type StageEventExtra = {
  callId?: string;
  toolName?: string;
  callNotStarted?: boolean;
  awaiting?: boolean;
  gate?: ToolGate;
  stop?: TurnStop;
};

/** Build a stream `stage` event. Unknown extra keys are not copied. */
export function stageEventFields(stage: TurnStage, extra?: Partial<StageEventExtra>): TurnEvent {
  const event: TurnEvent = { type: 'stage', stage };
  if (!extra) return event;
  if (extra.callId !== undefined) event.callId = extra.callId;
  if (extra.toolName !== undefined) event.toolName = extra.toolName;
  if (extra.callNotStarted !== undefined) event.callNotStarted = extra.callNotStarted;
  if (extra.awaiting !== undefined) event.awaiting = extra.awaiting;
  if (extra.gate !== undefined) event.gate = extra.gate;
  if (extra.stop !== undefined) event.stop = extra.stop;
  return event;
}

/** True when another provider step would exceed profile/generation maxSteps. */
export function injectWouldExceedMaxSteps(
  stepCount: number,
  maxSteps: number | undefined,
): boolean {
  if (maxSteps === undefined || maxSteps <= 0) return false;
  return stepCount >= maxSteps;
}

/** One stage run: the shared call bag plus who handles it and how injects are gated. */
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
  /** See `StageApplyInput.mutable`. */
  mutable?: boolean;
  host?: unknown;
  signal?: AbortSignal;
}

/** Applied stage output. `inject` is sanitized and always present. */
export interface RunStageOutput extends Omit<StageApplyOutput, 'inject'> {
  inject: TurnHistoryMessage[];
}

/**
 * Merge per-handler applied outputs in call order. Later scalars win, `inject`
 * lists concatenate, warnings accumulate. `deny` beats `confirm` across handlers
 * exactly as it does within one return.
 */
function mergeApplied(parts: readonly StageApplyOutput[]): StageApplyOutput {
  const out: StageApplyOutput = { warnings: parts.flatMap((part) => part.warnings) };
  for (const part of parts) {
    if (part.abort !== undefined) out.abort = part.abort;
    if (part.deny) out.deny = part.deny;
    if (part.confirm) out.confirm = part.confirm;
    if (part.mutate) out.mutate = part.mutate;
    if (part.inject?.length) out.inject = [...(out.inject ?? []), ...part.inject];
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

/**
 * Run one stage: emit the `stage` event, call the handlers, apply the affordance
 * matrix per handler, emit any warnings, sanitize injects (with a `guardrail`
 * event when redaction fired). Stage events always emit, even with no handlers.
 */
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
    ...bag
  } = args;
  throwIfAborted(signal);

  // Stream stage events stay lean (no outputRaw/failure). Hosts read those on
  // StageContext via onStage; tool failures also ride tool events.
  yield stageEventFields(stage, {
    callId: bag.callId,
    toolName: bag.tool,
    callNotStarted: bag.callNotStarted,
    awaiting: bag.awaiting,
    gate: bag.gate,
    stop: bag.stop,
  });

  if (handlers.length === 0) return { warnings: [], inject: [] };

  const ctx: StageContext = { stage, step, history, host, ...bag };
  const applied = mergeApplied(
    await applyHandlers(
      handlers,
      ctx,
      { stage, injectAllowed, injectWouldExceedMaxSteps, mutable },
      signal,
    ),
  );

  if (applied.warnings.length > 0) {
    yield {
      ...stageEventFields(stage, { callId: bag.callId, toolName: bag.tool }),
      stageWarnings: applied.warnings,
    };
  }

  const { inject, ...rest } = applied;
  if (!inject?.length) return { ...rest, inject: [] };
  const hits: GuardrailHit[] = [];
  const sanitized = sanitizeHistory(
    inject,
    detectionForTrust(resolveGuardrailPolicy(guardrails), 'untrusted'),
    hits,
  );
  const redacted = guardrailFromHits('history', 'untrusted', hits, 'redact');
  if (redacted) yield redacted;
  return { ...rest, inject: sanitized };
}
