import { assertEquals, assertNotEquals } from '@std/assert';
import type { TurnEvent } from '../../mod.ts';
import { CASSETTE_MODELS, modelSlug, normalizeOutcome, outcomeOf } from './cases.ts';

Deno.test('cassette outcomes list each rule per event while retaining actions, signals, events, and effects', () => {
  const event: Extract<TurnEvent, { type: 'guardrail' }> = {
    type: 'guardrail',
    guardrail: {
      stage: 'input',
      trust: 'untrusted',
      action: 'redact',
      hits: [
        { rule: 'detect.injection', severity: 'high' },
        { rule: 'detect.injection', severity: 'high' },
      ],
    },
  };
  const single: TurnEvent = {
    ...event,
    guardrail: { ...event.guardrail, hits: event.guardrail.hits.slice(0, 1) },
  };
  assertEquals(outcomeOf([event]), outcomeOf([single]));
  assertEquals(
    normalizeOutcome({
      ...outcomeOf([single]),
      guardrails: ['input redact detect.injection+detect.injection'],
    }),
    outcomeOf([single]),
  );
  assertNotEquals(
    outcomeOf([
      {
        ...event,
        guardrail: {
          ...event.guardrail,
          hits: [{ rule: 'detect.injection', severity: 'high', signal: 'new' }],
        },
      },
    ]),
    outcomeOf([single]),
  );
  assertNotEquals(outcomeOf([event, event]), outcomeOf([single]));
  assertNotEquals(
    outcomeOf([{ ...event, guardrail: { ...event.guardrail, action: 'block' } }]),
    outcomeOf([single]),
  );
  assertNotEquals(
    outcomeOf([
      {
        ...event,
        guardrail: {
          ...event.guardrail,
          hits: [...event.guardrail.hits, { rule: 'detect.credentials', severity: 'high' }],
        },
      },
    ]),
    outcomeOf([single]),
  );
  assertNotEquals(outcomeOf([event], ['email sent']), outcomeOf([single]));
  assertNotEquals(outcomeOf([event, { type: 'error', errorKind: 'network' }]), outcomeOf([single]));
  assertNotEquals(
    outcomeOf([event, { type: 'text', text: 'different reply' }]),
    outcomeOf([single]),
  );
});

Deno.test('every cassette model has a replay file of its own', () => {
  for (const { apiId } of CASSETTE_MODELS) {
    const file = new URL(`./replay.${modelSlug(apiId)}.test.ts`, import.meta.url);
    assertEquals(Deno.statSync(file).isFile, true, apiId);
  }
});
