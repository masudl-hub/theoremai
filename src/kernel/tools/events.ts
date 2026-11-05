import type { z } from 'zod';
import { throwIfAborted } from '../../guardrails/error.ts';
import { type LabelOverrides, labelText } from '../../guardrails/labels.ts';
import { assertSafeUrl } from '../../guardrails/network.ts';
import { resolveGuardrailPolicy } from '../../guardrails/policy.ts';
import { NETWORK_RULES } from '../../guardrails/rules.ts';
import type { GuardrailEvent, NetworkGuardrailSpec } from '../../guardrails/types.ts';
import type { SpanHandle } from '../../observability/trace-span.ts';
import { recordToolCheck } from '../engine/tool-trace.ts';
import { type Source, sourceSchema } from '../turn-events.ts';
import type { TurnEvent, TurnEventOf } from '../types.ts';
import { isRecord } from '../util/record.ts';
import { fillActivityLabel, toolNameInWords } from './activity-label.ts';
import { formatToolFailureForModel, formatToolResult } from './model-text.ts';
import type { ToolOperationClaim } from './operation.ts';
import type {
  ToolCallRequest,
  ToolContext,
  ToolFailure,
  ToolLabels,
  ToolPhaseEvent,
} from './types.ts';

export type ToolCallBase = Pick<ToolPhaseEvent, 'name' | 'callId'> & {
  operationId?: string;
  /** The call's failed label, from {@linkcode failedActivity}; absent, a failure names the tool. */
  activityFailed?: string;
};

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ToolPhasePatch = DistributiveOmit<ToolPhaseEvent, keyof ToolCallBase | 'at'>;

export function toolEvent(base: ToolCallBase, patch: ToolPhasePatch): TurnEventOf<'tool'> {
  return {
    type: 'tool',
    tool: {
      ...patch,
      name: base.name,
      callId: base.callId,
      ...(base.operationId ? { operationId: base.operationId } : {}),
      at: Date.now(),
    },
  };
}

/**
 * The label a failed call shows: the tool's own, filled from the input the model sent, else the
 * labels' line naming the tool in words.
 */
export function failedActivity(
  name: string,
  profileLabels?: LabelOverrides,
  labels?: ToolLabels,
  input?: unknown,
): string {
  return (
    fillActivityLabel(labels?.activityFailed, { input }) ??
    labelText('tool.activity_failed', { tool: toolNameInWords(name) }, profileLabels)
  );
}

/** The failed label of the call `base` names. */
export function failedActivityOf(base: ToolCallBase): string {
  return base.activityFailed ?? failedActivity(base.name);
}

/** `readBack` is passed when the call's result guard already wrote the model's text. */
export function failureEvent(
  base: ToolCallBase,
  failure: ToolFailure,
  readBack: string = formatToolResult(formatToolFailureForModel(failure)),
): TurnEventOf<'tool'> {
  return toolEvent(base, {
    phase: 'error',
    failure,
    readBack,
    activityPast: failedActivityOf(base),
  });
}

/** The first event of every call. */
export function toolCallRequestEvent(
  base: ToolCallBase,
  args: Record<string, unknown>,
  {
    reasoning,
    stepId,
    stepCallCount,
  }: Pick<ToolCallRequest, 'reasoning' | 'stepId' | 'stepCallCount'> = {},
): TurnEventOf<'tool'> {
  return {
    type: 'tool',
    tool: {
      name: base.name,
      callId: base.callId,
      ...(base.operationId ? { operationId: base.operationId } : {}),
      arguments: args,
      ...(reasoning?.length ? { reasoning } : {}),
      ...(stepId ? { stepId } : {}),
      ...(stepCallCount ? { stepCallCount } : {}),
    },
  };
}

/** Unique: readers join a call's events by it. */
export function newCallId(name: string): string {
  return `call_${name}_${crypto.randomUUID()}`;
}

export function toolCallArguments(safeInput: unknown): Record<string, unknown> {
  if (safeInput === undefined) return {};
  return isRecord(safeInput) ? safeInput : { value: safeInput };
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sourcesInvalid(base: ToolCallBase, message: string): TurnEventOf<'tool'> {
  return toolEvent(base, {
    phase: 'warning',
    warning: { code: 'sources_invalid', message, severity: 'warning' },
  });
}

export function* sourceEvents(
  base: ToolCallBase,
  sources: (output: unknown) => Source[],
  output: unknown,
): Generator<TurnEvent> {
  let listed: unknown;
  try {
    listed = sources(output);
  } catch (err) {
    yield sourcesInvalid(base, `sources threw: ${messageOf(err)}`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return;
  }
  if (!Array.isArray(listed)) {
    yield sourcesInvalid(base, 'sources must return an array'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return;
  }
  const cited: Source[] = [];
  const invalid: string[] = [];
  listed.forEach((entry: unknown, index) => {
    const parsed = sourceSchema.safeParse(entry);
    if (parsed.success) cited.push(parsed.data);
    else
      invalid.push(
        `[${String(index)}] ${parsed.error.issues.map((i) => `${i.path.join('.') || 'source'}: ${i.message}`).join('; ')}`,
      );
  });
  if (invalid.length > 0) {
    yield sourcesInvalid(base, `sources not cited: ${invalid.join(' | ')}`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (cited.length > 0) yield { type: 'citation', sources: cited, callId: base.callId };
}

function toolRunningEvent(
  tool: { labels?: ToolLabels },
  rawInput: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
): TurnEvent {
  const edited = ctx.resume?.edited;
  const activity = fillActivityLabel(tool.labels?.activity, { input: rawInput });
  return toolEvent(base, {
    phase: 'running',
    ...(edited ? { edited: { from: edited.from, to: toolCallArguments(rawInput) } } : {}),
    ...(activity ? { activity } : {}),
  });
}

/** A call's claim, taken once at the hand-off: right before the destination is asked. */
export class HandOff {
  private taken?: Promise<ToolOperationClaim | undefined>;
  private failed?: { error: unknown };

  constructor(private begin?: () => Promise<ToolOperationClaim | undefined>) {}

  claim(): Promise<ToolOperationClaim | undefined> {
    this.taken ??= (this.begin?.() ?? Promise.resolve(undefined)).catch((error: unknown) => {
      this.failed = { error };
      throw error;
    });
    return this.taken;
  }

  /** The claim's own failure is the coordinator's, so no tool catch may turn it into a tool failure. */
  rethrowClaimFailure(): void {
    if (this.failed) throw this.failed.error;
  }
}

export async function* dispatchToolBody(
  tool: { labels?: ToolLabels },
  input: unknown,
  ctx: ToolContext,
  base: ToolCallBase,
  beginBody?: (preparedInput: unknown) => Promise<ToolOperationClaim | undefined>,
): AsyncGenerator<TurnEvent, HandOff> {
  throwIfAborted(ctx.signal);
  yield toolRunningEvent(tool, input, ctx, base);
  return new HandOff(beginBody && (() => beginBody(input)));
}

export function startToolExecution<T>(
  tool: { input: z.ZodType<T> },
  rawInput: unknown,
  ctx: ToolContext,
): { ok: true; data: T } | { ok: false; failure: ToolFailure } {
  throwIfAborted(ctx.signal);
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        code: 'invalid_input',
        kind: 'bad_response',
        message: labelText('tool.input_invalid', {}, ctx.profile.labels),
        details: parsed.error.flatten(),
      },
    };
  }
  return { ok: true, data: parsed.data };
}

export function networkBlockedEvent(): GuardrailEvent {
  return {
    stage: 'network',
    trust: 'untrusted',
    action: 'block',
    hits: [{ rule: NETWORK_RULES.blocked, severity: 'high' }],
  };
}

export function* networkBlocked(
  err: unknown,
  guardrail: GuardrailEvent = networkBlockedEvent(),
): Generator<TurnEvent, ToolFailure> {
  yield { type: 'guardrail', guardrail };
  return { code: 'network_blocked', kind: 'blocked', message: messageOf(err) };
}

/**
 * Shared by HTTP and MCP so they cannot diverge on what SSRF enforcement means.
 * The check's time goes on the tool's span, when the call is traced.
 */
export function* guardToolTarget(
  url: string,
  ctx: ToolContext,
  span?: SpanHandle,
): Generator<TurnEvent, { ok: true; url: URL } | { ok: false; failure: ToolFailure }> {
  const start = performance.now();
  try {
    const safe = assertSafeUrl(url, toolNetworkPolicy(ctx));
    recordToolCheck(span, 'network', performance.now() - start, undefined);
    return { ok: true, url: safe };
  } catch (err) {
    const blocked = networkBlockedEvent();
    recordToolCheck(span, 'network', performance.now() - start, blocked);
    return { ok: false, failure: yield* networkBlocked(err, blocked) };
  }
}

/** The checks a guarded request runs on its way, timed together: each hop's address, and its lookup. */
export interface RequestChecks {
  /** Pass as `fetchGuarded`'s `onCheck`. */
  onCheck: (ms: number) => void;
  /** Records the checks once, when any ran, with the block they raised. */
  record: (blocked?: GuardrailEvent) => void;
}

export function requestChecks(span: SpanHandle | undefined): RequestChecks {
  let ms = 0;
  let ran = false;
  let recorded = false;
  return {
    onCheck: (took) => {
      ms += took;
      ran = true;
    },
    record: (blocked) => {
      if (recorded || !ran) return;
      recorded = true;
      recordToolCheck(span, 'network_request', ms, blocked);
    },
  };
}

export function toolNetworkPolicy(ctx: ToolContext): NetworkGuardrailSpec | undefined {
  return resolveGuardrailPolicy(ctx.profile.guardrails).network;
}
