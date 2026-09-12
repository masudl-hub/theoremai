/**
 * Turn-stage types and defensive affordance application.
 *
 * Contract: `docs/contracts/stages.md`. This module freezes shapes and
 * pressure-tests invalid host returns. Runner wiring is a separate cutover;
 * do not treat this as a shipped stages product until all three slices land.
 *
 * @module
 */

import {
  AWAITING_USER_INPUT_KINDS,
  AWAITING_USER_INPUT_STATUS,
  type AwaitingUserInputKind,
  TOOL_GATE_KINDS,
  TOOL_PERMISSION,
  type ToolGateKind,
  type ToolPermission,
  TURN_INJECT_STAGES,
  TURN_STAGES,
  type TurnInjectStage,
  type TurnStage,
} from './schema.ts';
import type { TurnStop } from './stop.ts';
import type { ModelToolResult, ToolFailure, ToolGate } from './tools/types.ts';
import type { TurnEvent, TurnHistoryMessage } from './types.ts';

export type { AwaitingUserInputKind, ToolGate, ToolGateKind, TurnInjectStage, TurnStage };

const STAGE_SET = new Set<string>(TURN_STAGES);
const INJECT_STAGE_SET = new Set<string>(TURN_INJECT_STAGES);
const GATE_KIND_SET = new Set<string>(TOOL_GATE_KINDS);
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
    post_tool: Object.freeze(['inject', 'abort'] as const),
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

/** Context passed to `onStage`. Frozen for slice 1. */
export interface StageContext {
  stage: TurnStage;
  /** 1-based provider step (text) or utterance cycle index (live). */
  step: number;
  history: readonly TurnHistoryMessage[];
  /** Opaque host slot — never traced or client-forwarded by the kernel. */
  host?: unknown;
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
}

/** Host return from `onStage`. Frozen for slice 1. */
export interface StageResult {
  inject?: TurnHistoryMessage[];
  abort?: boolean | { reason?: string };
  deny?: { code?: string; message?: string };
  /** `pre_tool` only — request a confirm/permission gate. */
  confirm?: true | { summary?: string };
  mutate?: { input: unknown };
}

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
}

export interface StageApplyOutput {
  inject?: TurnHistoryMessage[];
  abort?: boolean | { reason?: string };
  deny?: { code: string; message: string };
  confirm?: { summary?: string };
  mutate?: { input: unknown };
  warnings: StageApplyWarning[];
}

/** True when `value` is a known `TurnStage`. */
export function isTurnStage(value: unknown): value is TurnStage {
  return typeof value === 'string' && STAGE_SET.has(value);
}

/** True when inject is physically meaningful at this stage (gate still required). */
export function isTurnInjectStage(value: unknown): value is TurnInjectStage {
  return typeof value === 'string' && INJECT_STAGE_SET.has(value);
}

/** True when `value` is a known tool-gate kind. */
export function isToolGateKind(value: unknown): value is ToolGateKind {
  return typeof value === 'string' && GATE_KIND_SET.has(value);
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
    if (!isRecord(value.authChallenge)) return undefined;
    const ac = value.authChallenge;
    if (typeof ac.slot !== 'string' || !ac.slot.trim()) return undefined;
    if (ac.authType !== 'bearer' && ac.authType !== 'api_key' && ac.authType !== 'oauth2') {
      return undefined;
    }
    if (typeof ac.message !== 'string' || !ac.message.trim()) return undefined;
    const authChallenge: NonNullable<ToolGate['authChallenge']> = {
      slot: ac.slot.trim(),
      authType: ac.authType,
      message: ac.message.trim(),
    };
    if (typeof ac.authorizationUrl === 'string') {
      authChallenge.authorizationUrl = ac.authorizationUrl;
    }
    if (typeof ac.state === 'string') authChallenge.state = ac.state;
    if (typeof ac.issuer === 'string') authChallenge.issuer = ac.issuer;
    if (typeof ac.resource === 'string') authChallenge.resource = ac.resource;
    if (Array.isArray(ac.requiredScopes)) {
      const scopes: string[] = [];
      for (const s of ac.requiredScopes) {
        if (typeof s === 'string' && s.trim()) scopes.push(s.trim());
      }
      if (scopes.length > 0) authChallenge.requiredScopes = scopes;
    }
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
    warn(warnings, 'inject_invalid_messages', 'inject', 'inject entry must be an object');
    return undefined;
  }
  if (item.role === 'tool') {
    warn(
      warnings,
      'inject_invalid_messages',
      'inject',
      'inject messages with role "tool" are rejected',
    );
    return undefined;
  }
  if (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system') {
    warn(
      warnings,
      'inject_invalid_messages',
      'inject',
      `inject role not allowed: ${String(item.role)}`,
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
        'inject content must be a string when present',
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
        'inject parts must be an array when present',
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
        'inject tool_calls must be an array when present',
      );
      return undefined;
    }
    msg.tool_calls = item.tool_calls as TurnHistoryMessage['tool_calls'];
  }
  if (item.name !== undefined) {
    if (typeof item.name !== 'string') {
      warn(warnings, 'inject_invalid_messages', 'inject', 'inject name must be a string');
      return undefined;
    }
    msg.name = item.name;
  }
  if (item.metadata !== undefined) {
    if (!isRecord(item.metadata)) {
      warn(warnings, 'inject_invalid_messages', 'inject', 'inject metadata must be a plain object');
      return undefined;
    }
    msg.metadata = { ...item.metadata };
  }
  if (item.tool_call_id !== undefined) {
    warn(
      warnings,
      'inject_invalid_messages',
      'inject',
      'inject tool_call_id is rejected (not a tool-role message)',
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
      'inject must be an array of history messages',
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

/**
 * Defensively apply a host stage return against the affordance matrix.
 * Never throws. Invalid fields become warnings and are dropped.
 */
export function applyStageResult(input: StageApplyInput): StageApplyOutput {
  const warnings: StageApplyWarning[] = [];
  const out: StageApplyOutput = { warnings };
  const { stage, result, injectAllowed, injectWouldExceedMaxSteps } = input;

  if (result == null) return out;
  if (!isRecord(result)) {
    warn(warnings, 'result_invalid', 'result', 'StageResult must be a plain object');
    return out;
  }

  for (const key of Object.keys(result)) {
    if (!STAGE_RESULT_KEYS.has(key)) {
      warn(warnings, 'unknown_field', key, `unknown StageResult field "${key}" ignored`);
    }
  }

  if ('inject' in result && result.inject !== undefined) {
    if (!stageAllowsAffordance(stage, 'inject')) {
      warn(warnings, 'affordance_not_allowed', 'inject', `inject is not allowed at stage ${stage}`);
    } else if (!injectAllowed) {
      warn(
        warnings,
        'inject_not_allowed',
        'inject',
        'inject gate is closed for this profile/session',
      );
    } else if (injectWouldExceedMaxSteps) {
      warn(
        warnings,
        'inject_rejected_max_steps',
        'inject',
        'inject rejected: another model step would exceed maxSteps',
      );
    } else {
      const messages = coerceHistoryMessages(result.inject, warnings);
      if (messages) out.inject = messages;
    }
  }

  if ('abort' in result && result.abort !== undefined) {
    if (!stageAllowsAffordance(stage, 'abort')) {
      warn(warnings, 'affordance_not_allowed', 'abort', 'abort is not allowed at post_turn');
    } else if (result.abort === true) {
      out.abort = true;
    } else if (isRecord(result.abort)) {
      const reason =
        typeof result.abort.reason === 'string' && result.abort.reason.trim()
          ? result.abort.reason.trim()
          : undefined;
      out.abort = reason ? { reason } : true;
    } else if (result.abort === false) {
      // explicit no-op
    } else {
      warn(warnings, 'abort_invalid', 'abort', 'abort must be boolean or { reason?: string }');
    }
  }

  if ('deny' in result && result.deny !== undefined) {
    if (!stageAllowsAffordance(stage, 'deny')) {
      warn(warnings, 'affordance_not_allowed', 'deny', `deny is not allowed at stage ${stage}`);
    } else if (!isRecord(result.deny)) {
      warn(warnings, 'deny_invalid', 'deny', 'deny must be an object');
    } else {
      const code =
        typeof result.deny.code === 'string' && result.deny.code.trim()
          ? result.deny.code.trim()
          : 'not_authorized';
      const message =
        typeof result.deny.message === 'string' && result.deny.message.trim()
          ? result.deny.message.trim()
          : 'Tool execution not authorized';
      out.deny = { code, message };
    }
  }

  if ('confirm' in result && result.confirm !== undefined) {
    if (!stageAllowsAffordance(stage, 'confirm')) {
      warn(
        warnings,
        'affordance_not_allowed',
        'confirm',
        `confirm is not allowed at stage ${stage}`,
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
      warn(warnings, 'confirm_invalid', 'confirm', 'confirm must be true or { summary?: string }');
    }
  }

  if ('mutate' in result && result.mutate !== undefined) {
    if (!stageAllowsAffordance(stage, 'mutate')) {
      warn(warnings, 'affordance_not_allowed', 'mutate', `mutate is not allowed at stage ${stage}`);
    } else if (!isRecord(result.mutate) || !('input' in result.mutate)) {
      warn(warnings, 'mutate_invalid', 'mutate', 'mutate must be { input: unknown }');
    } else {
      out.mutate = { input: result.mutate.input };
    }
  }

  // confirm + deny together: deny wins
  if (out.deny && out.confirm) {
    warn(warnings, 'confirm_invalid', 'confirm', 'confirm ignored because deny is set');
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
