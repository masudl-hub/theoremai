import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  LABEL_KEYS,
  LABEL_NOTES,
  labelPlaceholders,
  validateLabelOverrides,
} from '../../src/guardrails/labels.ts';

Deno.test('each labels note names the placeholders its key takes', () => {
  for (const key of LABEL_KEYS) {
    const named = [...LABEL_NOTES[key].matchAll(/\{(\w+)\}/g)].map(([, name]) => name);
    assertEquals(new Set(named), new Set(labelPlaceholders(key)), key);
  }
});

Deno.test('a label override may leave out a placeholder its key takes', () => {
  validateLabelOverrides({ 'tool.not_allowed': "'{tool}' can't be used here." }, 'Profile p');
});

Deno.test('a label override may use only the placeholders its key takes', () => {
  assertThrows(
    () => validateLabelOverrides({ 'tool.not_allowed': "'{tol}' is off." }, 'Profile p'),
    TheoremError,
    "Profile p: labels 'tool.not_allowed' has {tol}, which is never filled in; it may only use {tool}, {profile}",
  );
  assertThrows(
    () => validateLabelOverrides({ 'error.cancelled': 'Stopped {when}.' }, 'Profile p'),
    TheoremError,
    "labels 'error.cancelled' has {when}, which is never filled in; it may only use {tool}",
  );
  assertThrows(
    () => validateLabelOverrides({ 'voice.empty': 'Nothing from {user}.' }, 'Profile p'),
    TheoremError,
    "labels 'voice.empty' has {user}, which is never filled in; it takes no placeholders",
  );
});

Deno.test('a canary note override must keep {canary}', () => {
  assertThrows(
    () => validateLabelOverrides({ 'canary.bind_note': 'Keep it secret.' }, 'Profile p'),
    TheoremError,
    "labels 'canary.bind_note' must contain the {canary} placeholder",
  );
});
