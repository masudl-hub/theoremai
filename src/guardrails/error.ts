/**
 * Public-safe error mapping for THEOREM.
 *
 * Kernel internals may contain provider status text, tool names, or exception
 * details. This module maps those failures to stable user-safe strings from the
 * kernel lexicon (`public.*` keys) so hosts can override them via
 * `overrideLexicon`.
 *
 * @module
 */

import { lexiconDefault, lexiconText } from './lexicon.ts';
import { TheoremError } from './theorem-error.ts';

/** Internal marker for provider or transport failure. */
const UPSTREAM_FAILED = 'upstream failed';

/** Snapshot of the registered default (ignores host overrides). Stable for tests. */
const PUBLIC_GENERIC: string = lexiconDefault('public.generic');
const PUBLIC_UNAVAILABLE: string = lexiconDefault('public.unavailable');
const PUBLIC_CANARY: string = lexiconDefault('public.canary');
const PUBLIC_ACTION: string = lexiconDefault('public.action');
const PUBLIC_FILE_TYPE: string = lexiconDefault('public.file_type');
const PUBLIC_FILE_SIZE: string = lexiconDefault('public.file_size');
const PUBLIC_FILE_COUNT: string = lexiconDefault('public.file_count');
const PUBLIC_IMAGE_SIZE: string = lexiconDefault('public.image_size');
const PUBLIC_CANCELLED: string = lexiconDefault('public.cancelled');

/** True when `err` is an abort (DOMException or Error named AbortError). */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError';
}

/** Throw if `signal` is already aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const { reason } = signal;
  if (isAbortError(reason)) {
    throw reason;
  }
  throw new DOMException('The operation was aborted.', 'AbortError'); // lexicon-exempt: DOM AbortError fingerprint
}

type PublicKey =
  | 'public.generic'
  | 'public.unavailable'
  | 'public.canary'
  | 'public.action'
  | 'public.file_type'
  | 'public.file_size'
  | 'public.file_count'
  | 'public.image_size'
  | 'public.cancelled'
  | 'public.bad_request'
  | 'public.invalid_question';

/** Resolve public copy at call time so `overrideLexicon` takes effect. */
function publicCopy(key: PublicKey): string {
  return lexiconText(key);
}

/** Upstream/internal message fingerprints → public lexicon keys (not emit copy). */
const EXACT: Record<string, PublicKey> = {
  [UPSTREAM_FAILED]: 'public.unavailable', // lexicon-exempt: internal marker
  'empty Gemini stream': 'public.unavailable', // lexicon-exempt: upstream fingerprint
  'canary leaked': 'public.canary', // lexicon-exempt: internal marker
  'The operation was aborted.': 'public.cancelled', // lexicon-exempt: AbortError fingerprint
  'This operation was aborted': 'public.cancelled', // lexicon-exempt: AbortError fingerprint
  'Turn withheld: egress disclosure violation': 'public.canary', // lexicon-exempt: internal marker
  'expected JSON object': 'public.bad_request', // lexicon-exempt: upstream fingerprint
  'structured output was not valid JSON': 'public.bad_request', // lexicon-exempt: upstream fingerprint
  'malformed Gemini Live message': 'public.unavailable', // lexicon-exempt: upstream fingerprint
  'malformed Gemini Live message during setup': 'public.unavailable', // lexicon-exempt: upstream fingerprint
  'user input cannot be placed in the system block': 'public.generic', // lexicon-exempt: internal marker
  'attachment data must be base64': 'public.file_type', // lexicon-exempt: internal marker
  'attachment is too large': 'public.file_size', // lexicon-exempt: internal marker
  'attachments exceed the per-turn budget': 'public.file_size', // lexicon-exempt: internal marker
  'Tool input validation failed': 'public.invalid_question', // lexicon-exempt: internal marker
  'This profile does not accept text input': 'public.action', // lexicon-exempt: internal marker
};

interface ErrorRule {
  match: (text: string) => boolean;
  resolve: (text: string) => string;
}

const RULES: ErrorRule[] = [
  {
    match: (t) =>
      /^(Gemini|OpenRouter|TTS|OpenRouter TTS|Speech) HTTP/.test(t) ||
      t.includes('TTS HTTP') ||
      t.includes('Speech HTTP'),
    resolve: () => publicCopy('public.unavailable'),
  },
  {
    match: (t) =>
      // lexicon-exempt: substring fingerprints against internal TheoremError messages
      t.includes('not enabled on this turn') ||
      t.includes('not allowed') ||
      t.includes('not registered') ||
      t.includes('Unknown model select') || // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      t.includes('Grounding tools') ||
      (t.includes('live.ingress.') && t.includes('is disabled')),
    resolve: () => publicCopy('public.action'),
  },
  {
    match: (t) =>
      // lexicon-exempt: substring fingerprints against internal TheoremError messages
      t.includes('MIME') ||
      t.includes('does not accept attachments') || // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      t.includes('does not accept voice'), // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    resolve: () => publicCopy('public.file_type'),
  },
  {
    match: (t) => t.startsWith('At most'),
    resolve: () => publicCopy('public.file_count'),
  },
  {
    match: (t) =>
      // lexicon-exempt: match already-lexicon attachment copy before remapping
      (t.startsWith('Only ') && t.includes('file')) ||
      t.startsWith('Each file must be') || // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      t.startsWith('Those files together'), // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    resolve: (t) => t,
  },
  {
    match: (t) => t.includes('attachment'),
    resolve: () => publicCopy('public.file_size'),
  },
  {
    // lexicon-exempt: substring fingerprint against internal TheoremError messages
    match: (t) => t.includes('aspect or size'),
    resolve: () => publicCopy('public.image_size'),
  },
  {
    match: (t) =>
      // lexicon-exempt: substring fingerprints against internal TheoremError messages
      t.includes('must pin thinking') || t.includes('has no models'),
    resolve: () => publicCopy('public.generic'),
  },
];

const PUBLIC_KEYS: readonly PublicKey[] = [
  'public.generic',
  'public.unavailable',
  'public.canary',
  'public.action',
  'public.file_type',
  'public.file_size',
  'public.file_count',
  'public.image_size',
  'public.cancelled',
  'public.bad_request',
  'public.invalid_question',
];

function isAlreadyPublic(text: string): boolean {
  return PUBLIC_KEYS.some((key) => lexiconText(key) === text || lexiconDefault(key) === text);
}

function publicText(text: string): string {
  if (/aborted/i.test(text)) {
    return publicCopy('public.cancelled');
  }
  if (isAlreadyPublic(text)) {
    return text;
  }
  const exact = EXACT[text];
  if (exact) {
    return publicCopy(exact);
  }
  for (const rule of RULES) {
    if (rule.match(text)) {
      return rule.resolve(text);
    }
  }
  return publicCopy('public.generic');
}

/** Convert an unknown thrown value or internal message to user-safe text. */
function publicError(err: unknown): string {
  if (isAbortError(err)) {
    return publicCopy('public.cancelled');
  }
  if (typeof err === 'string') {
    return publicText(err);
  }
  if (err instanceof TheoremError) {
    return publicText(err.message);
  }
  return publicCopy('public.unavailable');
}

/** Raw diagnostic text for hosts, traces, and logs (never shown to end users). */
function describeError(err: unknown): string {
  if (typeof err === 'string') {
    return err;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

/**
 * Stream error event with a public-safe `error` and a preserved `errorInternal`.
 * Providers and the runner should emit this instead of public-only error strings
 * so traces and host logs are never a black box.
 */
function toErrorEvent(err: unknown): {
  type: 'error';
  error: string;
  errorInternal: string;
} {
  return {
    type: 'error',
    error: publicError(err),
    errorInternal: describeError(err),
  };
}

export {
  describeError,
  isAbortError,
  PUBLIC_ACTION,
  PUBLIC_CANARY,
  PUBLIC_CANCELLED,
  PUBLIC_FILE_COUNT,
  PUBLIC_FILE_SIZE,
  PUBLIC_FILE_TYPE,
  PUBLIC_GENERIC,
  PUBLIC_IMAGE_SIZE,
  PUBLIC_UNAVAILABLE,
  publicError,
  TheoremError,
  throwIfAborted,
  toErrorEvent,
  UPSTREAM_FAILED,
};
