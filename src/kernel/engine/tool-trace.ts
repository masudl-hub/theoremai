import { errorKind } from '../../guardrails/error.ts';
import type { GuardrailEvent, GuardrailStage, ToolOrigin } from '../../guardrails/types.ts';
import {
  type SpanHandle,
  type TraceAttributes,
  traceContent,
  traceJson,
} from '../../observability/trace-span.ts';
import { authScopeRefusedSchema } from '../auth/scope-refusal.ts';
import type { ToolPermission } from '../schema.ts';
import type { ToolFailure, ToolGate } from '../tools/types.ts';
import type { InteractionPart, TurnEvent } from '../types.ts';
import {
  type GuardrailCheck,
  guardrailAttributes,
  guardrailCheckAttributes,
  optional,
  recordException,
  type SentToolCall,
  toolArgumentsText,
  tracePart,
} from './turn-trace.ts';

/** A check at the tool boundary: the call's arguments, the remote-content gate, the result, or the network target. */
type ToolCheck = Extract<
  GuardrailCheck,
  'tool_arguments' | 'taint' | 'tool_result' | 'tool_failure' | 'network' | 'network_request'
>;

const TOOL_CHECK_STAGE: Readonly<Record<ToolCheck, GuardrailStage>> = {
  tool_arguments: 'tool_call',
  taint: 'tool_call',
  tool_result: 'tool_result',
  tool_failure: 'tool_result',
  network: 'network',
  network_request: 'network',
};

/** Decisions already recorded with their check's time, so `observe` does not record them twice. */
const timedDecisions = new WeakSet<GuardrailEvent>();

/**
 * Records one tool-boundary check on the tool's span with the time it took:
 * its decision, or a pass (`allow`) when it let the call or result through.
 * Trace only; the host still hears about decisions alone. An untraced call has no span.
 */
function recordToolCheck(
  span: SpanHandle | undefined,
  check: ToolCheck,
  durationMs: number,
  guardrail: GuardrailEvent | undefined,
): void {
  if (!span) return;
  if (guardrail) timedDecisions.add(guardrail);
  span.event(
    'theorem.guardrail',
    guardrailCheckAttributes(check, durationMs, guardrail, {
      stage: TOOL_CHECK_STAGE[check],
      trust: 'untrusted',
    }),
  );
}

/** How a tool call ended. Only `error` is a failure; the rest were stopped or finished. */
type ToolOutcome = 'ok' | 'error' | 'denied' | 'gated' | 'paused' | 'cancelled';

interface ToolCallStart {
  name: string;
  callId: string;
  call: SentToolCall;
  /** Absent when the tool is not registered. */
  origin?: ToolOrigin;
  permission?: ToolPermission;
  /** The host's answer to an earlier gate, when this call resumes one. */
  approved?: boolean;
  /** The turn step whose model call asked for this tool. */
  step?: number;
}

interface ToolCallEnd {
  outcome: ToolOutcome;
  /** What the model reads back: its text and any media. Absent when nothing is read back. */
  result?: { text: string; parts?: readonly InteractionPart[] };
  /** The tool's raw output, present only when its body completed. */
  data?: { value: unknown };
  /** The failure, on `error`: its kind (`error.type`) and the tool's code for it. */
  failure?: Pick<ToolFailure, 'code' | 'kind'>;
  /** Thrown out of the call (not an abort). */
  thrown?: unknown;
}

interface ToolCallTrace {
  span: SpanHandle;
  observe: (event: TurnEvent) => void;
  end: (end: ToolCallEnd) => void;
}

function toolSpanName(name: string): string {
  return name ? `execute_tool ${name}` : 'execute_tool';
}

function toolSpanAttributes(start: ToolCallStart): TraceAttributes {
  return {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': start.name,
    'gen_ai.tool.call.id': start.callId,
    'gen_ai.tool.type': 'function',
    'gen_ai.tool.call.arguments': traceContent(toolArgumentsText(start.call)),
    ...optional('theorem.tool.origin', start.origin),
    ...optional('theorem.tool.permission', start.permission),
    ...optional('theorem.tool.approved', start.approved),
    ...optional('theorem.step', start.step),
  };
}

/** A gate as `theorem.gate` event attributes. The auth `state` is a secret and never recorded. */
function gateAttributes(gate: ToolGate): TraceAttributes {
  const auth = gate.kind === 'auth' ? gate.authChallenge : undefined;
  return {
    kind: gate.kind,
    ...optional('permission', gate.permission),
    ...(gate.summary ? { summary: traceContent(gate.summary) } : {}),
    ...(auth
      ? {
          auth: {
            slot: auth.slot,
            type: auth.authType,
            service: auth.service,
            ...optional('issuer', auth.issuer),
            ...optional('resource', auth.resource),
            ...optional('required_scopes', auth.requiredScopes),
          },
        }
      : {}),
  };
}

const OUTCOME_STATUS: Record<ToolOutcome, 'OK' | 'ERROR' | 'UNSET'> = {
  ok: 'OK',
  error: 'ERROR',
  denied: 'UNSET',
  gated: 'UNSET',
  paused: 'UNSET',
  cancelled: 'UNSET',
};

/**
 * Spans from before `pre_tool` to settlement, so it covers the hooks, the gates and the body.
 * Provider-run tools (search, maps, code execution) get no span: Theorem did not run them.
 * `open` places it: a child of the turn's root, or the root of a host-invoked tool's own record.
 */
function startToolTrace(
  open: (name: string, attributes: TraceAttributes) => SpanHandle,
  start: ToolCallStart,
): ToolCallTrace {
  const span = open(toolSpanName(start.name), toolSpanAttributes(start));
  return {
    span,
    observe: (event) => {
      if (event.type === 'guardrail' && !timedDecisions.has(event.guardrail)) {
        span.event('theorem.guardrail', guardrailAttributes(event.guardrail));
      }
      if (event.type === 'tool' && event.tool.phase === 'gate') {
        span.event('theorem.gate', gateAttributes(event.tool.gate));
      }
      if (event.type === 'tool' && event.tool.phase === 'progress') {
        const refused = authScopeRefusedSchema.safeParse(event.tool.data);
        if (refused.success) {
          const { slot, requested, declared } = refused.data;
          span.event('theorem.auth.scope_refused', { slot, requested, declared });
        }
      }
      if (event.type === 'tool' && event.tool.phase === 'warning') {
        const { code, message, severity } = event.tool.warning;
        span.event('theorem.tool.warning', {
          code,
          message: traceContent(message),
          ...optional('severity', severity),
        });
      }
      if (event.type === 'citation') {
        span.event('theorem.grounding', { sources: traceJson(event.sources) });
      }
    },
    end: (end) => {
      if (end.thrown !== undefined) recordException(span, end.thrown);
      const errorType =
        end.outcome === 'error'
          ? (end.failure?.kind ?? (end.thrown === undefined ? undefined : errorKind(end.thrown)))
          : undefined;
      span.set({
        ...(end.result ? { 'gen_ai.tool.call.result': traceContent(end.result.text) } : {}),
        ...(end.result?.parts?.length
          ? { 'theorem.tool.call.result.parts': end.result.parts.map(tracePart) }
          : {}),
        ...(end.data ? { 'theorem.tool.data': traceJson(end.data.value) } : {}),
        'theorem.tool.outcome': end.outcome,
        ...optional('theorem.tool.failure.code', end.failure?.code),
        ...optional('error.type', errorType),
      });
      const code = OUTCOME_STATUS[end.outcome];
      span.end(code === 'ERROR' && errorType ? { code, message: errorType } : { code });
    },
  };
}

export type { ToolCallEnd, ToolCallStart, ToolCallTrace, ToolCheck, ToolOutcome };
export { recordToolCheck, startToolTrace, toolSpanName };
