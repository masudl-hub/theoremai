import { assertEquals } from '@std/assert';
import { forClient, forClientEvents } from '../../src/host/client-turn.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import { firstOf } from '../fixtures/events.ts';

Deno.test('forClient strips errorInternal from error events', () => {
  const event: TurnEvent = {
    type: 'error',
    errorKind: 'unavailable',
    error: 'The service is temporarily unavailable.',
    errorInternal: 'Gemini HTTP 503: upstream timeout',
  };
  const client = firstOf([forClient(event)], 'error');
  assertEquals(client?.error, 'The service is temporarily unavailable.');
  assertEquals(Object.hasOwn(client ?? {}, 'errorInternal'), false);
});

Deno.test('forClient leaves error events without errorInternal unchanged', () => {
  const event: TurnEvent = { type: 'error', errorKind: 'internal', error: 'Something went wrong.' };
  assertEquals(forClient(event), event);
});

Deno.test('forClient strips errorInternal from an ended session', () => {
  const event: TurnEvent = {
    type: 'session',
    session: {
      kind: 'ended',
      message: 'The call has ended. Please start a new one to carry on.',
      ended: { cause: 'go_away', code: 1008, closedAfterMs: 41_000 },
    },
    errorInternal: 'Gemini Live WebSocket closed during session (1008: session limit)',
  };
  const client = firstOf([forClient(event)], 'session');
  assertEquals(Object.hasOwn(client ?? {}, 'errorInternal'), false);
  assertEquals(client?.session, event.type === 'session' ? event.session : undefined);
});

Deno.test('forClient strips errorInternal from guardrail events', () => {
  const event: TurnEvent = {
    type: 'guardrail',
    guardrail: {
      stage: 'output_final',
      trust: 'untrusted',
      action: 'block',
      hits: [{ rule: 'egress.enforcer-error', severity: 'high' }],
      errorInternal: 'classifier at 10.0.0.7 unreachable',
    },
  };
  const client = firstOf([forClient(event)], 'guardrail');
  assertEquals(client?.guardrail.action, 'block');
  assertEquals(Object.hasOwn(client?.guardrail ?? {}, 'errorInternal'), false);
  assertEquals(firstOf(forClientEvents([event]), 'guardrail')?.guardrail.errorInternal, undefined);
});

Deno.test('forClient strips evidence.raw by default', () => {
  const event: TurnEvent = {
    type: 'evidence',
    evidence: {
      provider: 'google',
      kind: 'code_execution_call',
      id: 'step-1',
      code: 'print(1)',
      raw: { type: 'code_execution_call', id: 'step-1' },
    },
  };
  assertEquals(forClient(event), {
    type: 'evidence',
    evidence: { provider: 'google', kind: 'code_execution_call', id: 'step-1', code: 'print(1)' },
  });
});

Deno.test('forClient keeps evidence.raw when includeEvidenceRaw is true', () => {
  const raw = { type: 'url_context_result' };
  const event: TurnEvent = {
    type: 'evidence',
    evidence: { provider: 'google', kind: 'provider_step', step: 'url_context_result', raw },
  };
  assertEquals(
    firstOf([forClient(event, { includeEvidenceRaw: true })], 'evidence')?.evidence.raw,
    raw,
  );
});

Deno.test('forClient passes through text, media, citations, and grounding unchanged', () => {
  const text: TurnEvent = { type: 'text', text: 'hello' };
  const media: TurnEvent = { type: 'media', media: { mimeType: 'image/png', data: 'abc' } };
  const citation: TurnEvent = {
    type: 'citation',
    sources: [{ title: 'Example', uri: 'https://example.com', type: 'web' }],
  };
  const grounding: TurnEvent = { type: 'grounding', grounding: { searchHtml: '<div></div>' } };
  assertEquals(forClient(text), text);
  assertEquals(forClient(media), media);
  assertEquals(forClient(citation), citation);
  assertEquals(forClient(grounding), grounding);
});

Deno.test('forClientEvents maps an entire batch', () => {
  const events: TurnEvent[] = [
    { type: 'text', text: 'hi' },
    {
      type: 'error',
      errorKind: 'unavailable',
      error: 'Unavailable',
      errorInternal: 'Gemini HTTP 500',
    },
  ];
  const out = forClientEvents(events);
  assertEquals(out.length, 2);
  assertEquals(out[0], { type: 'text', text: 'hi' });
  assertEquals(firstOf(out, 'error')?.errorInternal, undefined);
});

Deno.test('forClient strips GuardrailHit.match even when present', () => {
  const event: TurnEvent = {
    type: 'guardrail',
    guardrail: {
      stage: 'input',
      trust: 'untrusted',
      action: 'redact',
      hits: [
        {
          rule: 'sanitize.injection',
          severity: 'high',
          span: { start: 0, end: 10 },
          match: 'ignore all',
        },
      ],
    },
  };
  const hit = firstOf([forClient(event)], 'guardrail')?.guardrail.hits[0];
  assertEquals(hit?.rule, 'sanitize.injection');
  assertEquals(Object.hasOwn(hit ?? {}, 'match'), false);
});
