import { assertEquals } from '@std/assert';
import { googleBindingViolation, googleFreeTierBuiltins } from '../../src/presets/google.ts';

// Refusals recorded from Live setup on 01/10/2026: 3.8 Live closes 1007 on a thinking level,
// Extended Thinking closes 1007 without one, and a free key closes 1011 on googleSearch.
const live38 = { apiId: 'gemini-3.8-live', builtInTools: [] };

Deno.test('google preset: 3.8 Live takes no thinking level', () => {
  assertEquals(googleBindingViolation({ ...live38, efforts: { normal: 'low' } })?.field, 'efforts');
  assertEquals(googleBindingViolation({ ...live38, summaries: false })?.field, 'summaries');
  assertEquals(googleBindingViolation(live38), undefined);
});

Deno.test('google preset: 3.8 Live Extended Thinking needs a thinking level', () => {
  const binding = { apiId: 'gemini-3.8-live-extended-thinking', builtInTools: [] };
  assertEquals(googleBindingViolation(binding)?.field, 'efforts');
  assertEquals(googleBindingViolation({ ...binding, efforts: { normal: 'low' } }), undefined);
});

Deno.test('google preset: the free tier refuses grounding a model has no quota for', () => {
  const search = { ...live38, builtInTools: ['googleSearch'] };
  // Off the free tier, search is the account's business.
  assertEquals(googleBindingViolation(search), undefined);
  assertEquals(googleBindingViolation(search, { freeTier: true })?.field, 'builtInTools');
  assertEquals(
    googleBindingViolation(
      { apiId: 'gemini-2.5-flash', builtInTools: ['googleSearch', 'googleMaps'] },
      { freeTier: true },
    ),
    undefined,
  );
  assertEquals(googleFreeTierBuiltins('gemini-3.1-flash-lite'), ['googleMaps']);
});

Deno.test('google preset: the free tier refuses a model with no free quota', () => {
  assertEquals(
    googleBindingViolation(
      { apiId: 'gemini-3.1-pro-preview', builtInTools: [] },
      { freeTier: true },
    )?.field,
    'apiId',
  );
});
