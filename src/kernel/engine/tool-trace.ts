/**
 * The `execute_tool` span: one tool call Theorem ran or settled, from before
 * `pre_tool` to settlement, so it covers the hooks, the gates and the body.
 *
 * Provider-run tools (search, maps, code execution) are not spans here:
 * Theorem did not run them; they are parts of the model call's output.
 *
 * @module
 */

import type { ToolOrigin } from '../../guardrails/types.ts';
import {
  type SpanHandle,
  type TraceAttributes,
  traceContent,
  traceJson,
} from '../../observability/trace-span.ts';
import type { ToolPermission } from '../schema.ts';
import type { ToolGate } from '../tools/types.ts';
import type { InteractionPart, TurnEvent } from '../types.ts';
import {
  errorName,
  guardrailAttributes,
  optional,
  recordException,
  toolArgumentsText,
  tracePart,
} from './turn-trace.ts';

/** How a tool call ended. Only `error` is a failure; the rest were stopped or finished. */
type ToolOutcome = 'ok' | 'error' | 'denied' | 'gated' | 'paused' | 'cancelled';

/** What is known about a call when its span opens. */
interface ToolCallStart {
  name: string;
  callId: string;
  /** The call as the model or host sent it; see `toolArgumentsText`. */
  call: Pick<NonNullable<TurnEvent['tool']>, 'arguments' | 'failure'>;
  /** Absent when the tool is not registered. */
  origin?: ToolOrigin;
  permission?: ToolPermission;
  /** The host's answer to an earlier gate, when this call resumes one. */
  approved?: boolean;
  /** The turn step whose model call asked for this tool. */
  step?: number;
}

/** How a call settled. */
interface ToolCallEnd {
  outcome: ToolOutcome;
  /** What the model reads back: its text and any media. Absent when nothing is read back. */
  result?: { text: string; parts?: readonly InteractionPart[] };
  /** The tool's raw output, present only when its body completed. */
  data?: { value: unknown };
  /** The failure code, on `error`. */
  errorType?: string;
  /** Thrown out of the call (not an abort). */
  thrown?: unknown;
}

/** Recorder for one tool call's span. */
interface ToolCallTrace {
  span: SpanHandle;
  /** Every event the call emitted. */
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
  const auth = gate.authChallenge;
  return {
    kind: gate.kind,
    ...optional('permission', gate.permission),
    ...(gate.summary ? { summary: traceContent(gate.summary) } : {}),
    ...(auth
      ? {
          auth: {
            slot: auth.slot,
            type: auth.authType,
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
 * Open the `execute_tool` span for one call. `open` places it: a child of the
 * turn's root, or the root of a host-invoked tool's own record.
 */
function startToolTrace(
  open: (name: string, attributes: TraceAttributes) => SpanHandle,
  start: ToolCallStart,
): ToolCallTrace {
  const span = open(toolSpanName(start.name), toolSpanAttributes(start));
  return {
    span,
    observe: (event) => {
      if (event.guardrail) span.event('theorem.guardrail', guardrailAttributes(event.guardrail));
      if (event.tool?.phase === 'gate' && event.tool.gate) {
        span.event('theorem.gate', gateAttributes(event.tool.gate));
      }
    },
    end: (end) => {
      if (end.thrown !== undefined) recordException(span, end.thrown);
      const errorType =
        end.outcome === 'error'
          ? (end.errorType ?? (end.thrown === undefined ? undefined : errorName(end.thrown)))
          : undefined;
      span.set({
        ...(end.result ? { 'gen_ai.tool.call.result': traceContent(end.result.text) } : {}),
        ...(end.result?.parts?.length
          ? { 'theorem.tool.call.result.parts': end.result.parts.map(tracePart) }
          : {}),
        ...(end.data ? { 'theorem.tool.data': traceJson(end.data.value) } : {}),
        'theorem.tool.outcome': end.outcome,
        ...optional('error.type', errorType),
      });
      const code = OUTCOME_STATUS[end.outcome];
      span.end(code === 'ERROR' && errorType ? { code, message: errorType } : { code });
    },
  };
}

export type { ToolCallEnd, ToolCallStart, ToolCallTrace, ToolOutcome };
export { startToolTrace, toolSpanName };
