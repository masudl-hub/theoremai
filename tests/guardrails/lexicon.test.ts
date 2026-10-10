import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  LEXICON_KEYS,
  LEXICON_NOTES,
  lexiconPlaceholders,
  validateLexiconOverrides,
} from '../../src/guardrails/lexicon.ts';

Deno.test('each lexicon note names the placeholders its key takes', () => {
  for (const key of LEXICON_KEYS) {
    const named = [...LEXICON_NOTES[key].matchAll(/\{(\w+)\}/g)].map(([, name]) => name);
    assertEquals(new Set(named), new Set(lexiconPlaceholders(key)), key);
  }
});

Deno.test('a lexicon override may leave out a placeholder its key takes', () => {
  validateLexiconOverrides({ 'tool.not_allowed': "'{tool}' can't be used here." }, 'Profile p');
});

Deno.test('a lexicon override may use only the placeholders its key takes', () => {
  assertThrows(
    () => validateLexiconOverrides({ 'tool.not_allowed': "'{tol}' is off." }, 'Profile p'),
    TheoremError,
    "Profile p: lexicon 'tool.not_allowed' has {tol}, which is never filled in; it may only use {tool}, {profile}",
  );
  assertThrows(
    () => validateLexiconOverrides({ 'error.cancelled': 'Stopped {when}.' }, 'Profile p'),
    TheoremError,
    "lexicon 'error.cancelled' has {when}, which is never filled in; it may only use {tool}",
  );
  assertThrows(
    () => validateLexiconOverrides({ 'voice.empty': 'Nothing from {user}.' }, 'Profile p'),
    TheoremError,
    "lexicon 'voice.empty' has {user}, which is never filled in; it takes no placeholders",
  );
});

Deno.test('a canary note override must keep {canary}', () => {
  assertThrows(
    () => validateLexiconOverrides({ 'canary.bind_note': 'Keep it secret.' }, 'Profile p'),
    TheoremError,
    "lexicon 'canary.bind_note' must contain the {canary} placeholder",
  );
});
