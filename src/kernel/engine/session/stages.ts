/**
 * Live session stage emit + affordance application (`docs/contracts/stages.md`).
 *
 * Inject becomes realtime text ingress via `sendText` — never history parts.
 *
 * @module
 */

import { throwIfAborted } from '../../../guardrails/error.ts';
import { detectionForTrust, resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { sanitizeHistory } from '../../../guardrails/sanitize.ts';
import {
  applyStageResult,
  type StageApplyWarning,
  type StageContext,
  type StageHandler,
  type StageResult,
  stageEventFields,
  type TurnStage,
} from '../../stages.ts';
import { profileAllowsInject } from '../../stop.ts';
import type { LiveProfile, TurnEvent, TurnHistoryMessage, TurnStop } from '../../types.ts';

export type LiveCycleState = 'idle' | 'open';

export interface ApplyLiveStageArgs {
  profile: LiveProfile;
  stage: TurnStage;
  step: number;
  history: readonly TurnHistoryMessage[];
  onStage?: StageHandler;
  signal?: AbortSignal;
  host?: unknown;
  callId?: string;
  tool?: string;
  input?: unknown;
  callNotStarted?: boolean;
  outputRaw?: unknown;
  outputModel?: StageContext['outputModel'];
  failure?: StageContext['failure'];
  awaiting?: boolean;
  stop?: TurnStop;
  gate?: StageContext['gate'];
}

export interface ApplyLiveStageResult {
  abort?: boolean | { reason?: string };
  /** Text contents to send as live ingress (inject). */
  injectTexts: string[];
  warnings: StageApplyWarning[];
}

function sanitizeLiveInjects(
  profile: LiveProfile,
  messages: TurnHistoryMessage[],
): TurnHistoryMessage[] {
  const policy = resolveGuardrailPolicy(profile.guardrails);
  return sanitizeHistory(messages, detectionForTrust(policy, 'untrusted'));
}

/** Extract plain text from inject messages for live `sendText`. */
export function liveInjectTexts(messages: readonly TurnHistoryMessage[]): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') continue;
    if (msg.parts?.length) continue; // live refuses media-ref / parts inject
    const text = msg.content?.trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * Emit a `stage` event, invoke `onStage`, apply affordances.
 * Does not write the socket — caller applies `injectTexts` via `sendText`.
 */
export async function* applyLiveStage(
  args: ApplyLiveStageArgs,
): AsyncGenerator<TurnEvent, ApplyLiveStageResult> {
  throwIfAborted(args.signal);

  yield stageEventFields(args.stage, {
    callId: args.callId,
    toolName: args.tool,
    callNotStarted: args.callNotStarted,
    awaiting: args.awaiting,
    gate: args.gate,
    stop: args.stop,
  });

  const baseEmpty: ApplyLiveStageResult = { injectTexts: [], warnings: [] };
  if (!args.onStage) return baseEmpty;

  const ctx: StageContext = {
    stage: args.stage,
    step: args.step,
    history: args.history,
    host: args.host,
    callId: args.callId,
    tool: args.tool,
    input: args.input,
    callNotStarted: args.callNotStarted,
    outputRaw: args.outputRaw,
    outputModel: args.outputModel,
    failure: args.failure,
    awaiting: args.awaiting,
    stop: args.stop,
    gate: args.gate,
  };

  let raw: StageResult | undefined;
  try {
    raw = (await args.onStage(ctx)) ?? undefined;
  } catch (err) {
    throwIfAborted(args.signal);
    throw err;
  }
  throwIfAborted(args.signal);

  const applied = applyStageResult({
    stage: args.stage,
    result: raw,
    injectAllowed: profileAllowsInject(args.profile),
  });

  if (applied.warnings.length > 0) {
    yield {
      type: 'stage',
      stage: args.stage,
      stageWarnings: applied.warnings,
    };
  }

  const injectTexts = applied.inject?.length
    ? liveInjectTexts(sanitizeLiveInjects(args.profile, applied.inject))
    : [];

  return {
    abort: applied.abort,
    injectTexts,
    warnings: applied.warnings,
  };
}

/** True when audio payload should not open a live cycle. */
export function isEmptyLiveAudio(data: string | undefined): boolean {
  return !data || data.length === 0;
}
