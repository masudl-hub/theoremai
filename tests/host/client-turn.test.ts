import { assertEquals } from '@std/assert';
import { forClient, forClientEvents } from '../../src/host/client-turn.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

Deno.test('forClient strips errorInternal from error events', () => {
  const event: TurnEvent = {
    type: 'error',
    error: 'The service is temporarily unavailable.',
    errorInternal: 'Gemini HTTP 503: upstream timeout',
  };
  const client = forClient(event);
  assertEquals(client.error, event.error);
  assertEquals(client.errorInternal, undefined);
  assertEquals(Object.hasOwn(client, 'errorInternal'), false);
});

Deno.test('forClient leaves error events without errorInternal unchanged', () => {
  const event: TurnEvent = { type: 'error', error: 'Something went wrong.' };
  assertEquals(forClient(event), event);
});

Deno.test('forClient strips errorInternal from an ended session', () => {
  const event: TurnEvent = {
    type: 'session',
    session: { kind: 'ended', ended: { cause: 'go_away', code: 1008, closedAfterMs: 41_000 } },
    errorInternal: 'Gemini Live WebSocket closed during session (1008: session limit)',
  };
  const client = forClient(event);
  assertEquals(Object.hasOwn(client, 'errorInternal'), false);
  assertEquals(client.session, event.session);
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
  const client = forClient(event);
  assertEquals(client.guardrail?.action, 'block');
  assertEquals(Object.hasOwn(client.guardrail ?? {}, 'errorInternal'), false);
  assertEquals(forClientEvents([event])[0]?.guardrail?.errorInternal, undefined);
});

Deno.test('forClient strips evidence.raw by default', () => {
  const event: TurnEvent = {
    type: 'evidence',
    evidence: {
      provider: 'google',
      kind: 'code_execution_call',
      code: 'print(1)',
      raw: { type: 'code_execution_call', id: 'step-1' },
    },
  };
  const client = forClient(event);
  assertEquals(client.evidence?.kind, 'code_execution_call');
  assertEquals(client.evidence?.code, 'print(1)');
  assertEquals(client.evidence?.raw, undefined);
});

Deno.test('forClient keeps evidence.raw when includeEvidenceRaw is true', () => {
  const raw = { type: 'google_search_result' };
  const event: TurnEvent = {
    type: 'evidence',
    evidence: { provider: 'google', kind: 'search', raw },
  };
  const client = forClient(event, { includeEvidenceRaw: true });
  assertEquals(client.evidence?.raw, raw);
});

Deno.test('forClient passes through text, media, and grounding unchanged', () => {
  const text: TurnEvent = { type: 'text', text: 'hello' };
  const media: TurnEvent = { type: 'media', media: { mimeType: 'image/png', data: 'abc' } };
  const grounding: TurnEvent = {
    type: 'grounding',
    grounding: { sources: [{ title: 'Example', uri: 'https://example.com', type: 'web' }] },
  };
  assertEquals(forClient(text), text);
  assertEquals(forClient(media), media);
  assertEquals(forClient(grounding), grounding);
});

Deno.test('forClientEvents maps an entire batch', () => {
  const events: TurnEvent[] = [
    { type: 'text', text: 'hi' },
    {
      type: 'error',
      error: 'Unavailable',
      errorInternal: 'Gemini HTTP 500',
    },
  ];
  const out = forClientEvents(events);
  assertEquals(out.length, 2);
  assertEquals(out[0]?.text, 'hi');
  assertEquals(out[1]?.errorInternal, undefined);
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
  const client = forClient(event);
  assertEquals(client.guardrail?.hits[0]?.rule, 'sanitize.injection');
  assertEquals(client.guardrail?.hits[0]?.match, undefined);
  assertEquals(Object.hasOwn(client.guardrail?.hits[0] ?? {}, 'match'), false);
});
