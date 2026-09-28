/**
 * A synthetic turn trace for eval tests: one `invoke_agent` root with a
 * `chat` call, tool calls, a guardrail event, delivered text and structured
 * JSON, and usage. Built with the real span and record builders, so what the
 * graders read is what a turn would have written. No model in the loop.
 */

import type { EvalCase } from '../../src/evals/types.ts';
import { resolveObservabilityPolicy } from '../../src/observability/resolve-policy.ts';
import { buildRecord, type TraceRecord } from '../../src/observability/trace-record.ts';
import {
  startTrace,
  type TraceAttributes,
  type TraceClock,
  traceContent,
  traceJson,
} from '../../src/observability/trace-span.ts';
import type { ResolvedObservabilityPolicy } from '../../src/observability/types.ts';

const NANOS_PER_MS = 1_000_000n;

/** Records under an explicit `writeTo: false` policy: scrub on, nothing sampled away. */
const POLICY: ResolvedObservabilityPolicy = resolveObservabilityPolicy({ writeTo: false });

/** A clock the test moves by hand, in milliseconds. */
function manualClock(startMs = 1_700_000_000_000): TraceClock & { tickMs: (ms: number) => void } {
  let now = BigInt(startMs) * NANOS_PER_MS;
  return {
    nowUnixNano: () => now,
    tickMs: (ms) => {
      now += BigInt(ms) * NANOS_PER_MS;
    },
  };
}

interface TurnFixtureOptions {
  /** The model's own delivered text. */
  text?: string;
  /** The delivered structured output, when the profile has one. */
  structured?: unknown;
  /** Tools called, in order. */
  tools?: string[];
  stop?: string;
  costUsd?: number;
  responseId?: string;
  /** Seconds to first chunk on the chat span; measured from its successful HTTP try. */
  timeToFirstChunk?: number;
  /** Ms between the turn's start and the chat call, and between a failed first try and the one that answered. */
  beforeChatMs?: number;
  retryAfterMs?: number;
  /** A guardrail action recorded on the root. */
  guardrailAction?: 'allow' | 'redact' | 'flag' | 'block';
  /** Wall time of the whole turn, ms. */
  durationMs?: number;
  metadata?: Record<string, unknown>;
  clock?: TraceClock & { tickMs: (ms: number) => void };
  /** The policy the record is built under; default scrubs stored text. */
  policy?: ResolvedObservabilityPolicy;
}

/** One turn as its record. */
function turnRecord(options: TurnFixtureOptions = {}): Promise<TraceRecord> {
  const clock = options.clock ?? manualClock();
  const tree = startTrace('invoke_agent translator', {
    clock,
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'translator' },
  });
  clock.tickMs(options.beforeChatMs ?? 0);
  const chat = tree.root.child('chat gemini', {
    kind: 'CLIENT',
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gemini',
      ...(options.responseId ? { 'gen_ai.response.id': options.responseId } : {}),
      ...(options.timeToFirstChunk === undefined
        ? {}
        : { 'gen_ai.response.time_to_first_chunk': options.timeToFirstChunk }),
    },
  });
  if (options.retryAfterMs !== undefined) {
    const failed = chat.child('POST', {
      kind: 'CLIENT',
      attributes: { 'http.request.method': 'POST', 'http.response.status_code': 503 },
    });
    clock.tickMs(options.retryAfterMs);
    failed.end({ code: 'ERROR', message: '503' });
  }
  const served = chat.child('POST', {
    kind: 'CLIENT',
    attributes: { 'http.request.method': 'POST', 'http.response.status_code': 200 },
  });
  clock.tickMs(10);
  served.end();
  chat.end();
  for (const [i, name] of (options.tools ?? []).entries()) {
    const tool = tree.root.child(`execute_tool ${name}`, {
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': name,
        'gen_ai.tool.call.id': `call-${i}`,
        'theorem.tool.outcome': 'ok',
      },
    });
    clock.tickMs(5);
    tool.end();
  }
  if (options.guardrailAction) {
    tree.root.event('theorem.guardrail', {
      stage: 'input',
      trust: 'untrusted',
      action: options.guardrailAction,
      hits: [],
    });
  }
  const parts: TraceAttributes[] = [];
  if (options.text !== undefined) parts.push({ type: 'text', ...traceContent(options.text) });
  if (options.structured !== undefined) {
    // As the turn trace stores it: the JSON under the part's `content`.
    parts.push({ type: 'structured', content: traceJson(options.structured) });
  }
  tree.root.set({
    'gen_ai.output.messages': [{ role: 'assistant', parts }],
    'gen_ai.usage.input_tokens': 40,
    'gen_ai.usage.output_tokens': 12,
    'gen_ai.usage.reasoning.output_tokens': 4,
    ...(options.costUsd === undefined ? {} : { 'theorem.usage.cost_usd': options.costUsd }),
    'theorem.stop.kind': options.stop ?? 'completed',
    'theorem.attempts': 1,
    'theorem.steps': 1 + (options.tools?.length ?? 0),
  });
  clock.tickMs(options.durationMs ?? 100);
  tree.root.end();
  return buildRecord({
    spans: tree.collect(),
    policy: options.policy ?? POLICY,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

/** A Live session: one `invoke_agent` root with a `generate_content` response per step. */
function liveRecord(
  responses: Array<{
    /** Ms after the previous event that the person stopped speaking; omitted for a text step. */
    speechEndsAfterMs?: number;
    /** Ms after speech ended (or the step was sent) that the response's first input frame went out. */
    sentAfterMs?: number;
    /** Seconds from the response's start to its first chunk; omitted when unrecorded. */
    timeToFirstChunk?: number;
    transcript?: string;
    stop?: string;
  }>,
): Promise<TraceRecord> {
  const clock = manualClock();
  const tree = startTrace('invoke_agent greeter', {
    clock,
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'greeter' },
  });
  tree.root.event('theorem.session', { kind: 'setup_complete' });
  for (const response of responses) {
    if (response.speechEndsAfterMs !== undefined) {
      clock.tickMs(response.speechEndsAfterMs);
      tree.root.event('theorem.session', { kind: 'voice_activity', activity: 'ACTIVITY_END' });
    }
    clock.tickMs(response.sentAfterMs ?? 0);
    const span = tree.root.child('generate_content gemini-live', {
      kind: 'CLIENT',
      attributes: {
        'gen_ai.operation.name': 'generate_content',
        'gen_ai.request.model': 'gemini-live',
        'gen_ai.request.stream': true,
        'theorem.request.live': { voice: 'Kore' },
        ...(response.timeToFirstChunk === undefined
          ? {}
          : { 'gen_ai.response.time_to_first_chunk': response.timeToFirstChunk }),
      },
    });
    span.event('theorem.wire.request', { body: traceJson({ clientContent: {} }) });
    const parts: TraceAttributes[] = response.transcript
      ? [
          {
            type: 'text',
            ...traceContent(response.transcript),
            'theorem.source': 'output_transcription',
          },
        ]
      : [];
    span.set({
      'theorem.output.delivered': [{ role: 'assistant', parts }],
      'theorem.stop.kind': response.stop ?? 'completed',
    });
    clock.tickMs(400);
    span.end();
  }
  tree.root.event('theorem.session', { kind: 'closed', initiator: 'host' });
  tree.root.set({ 'theorem.steps': responses.length, 'theorem.stop.kind': 'completed' });
  tree.root.end();
  return buildRecord({ spans: tree.collect(), policy: POLICY });
}

/** A case whose expectations the default fixture meets. */
const CASE: EvalCase = {
  id: 'es-01',
  kind: 'regression',
  input: { text: 'Translate to Spanish: The kettle is on.' },
  expect: { tools: [], json: { lang: 'es' }, notes: 'no tool needed' },
};

export type { TurnFixtureOptions };
export { CASE, liveRecord, manualClock, POLICY, turnRecord };
