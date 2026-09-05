/**
 * Public-safe error mapping for THEORUM.
 *
 * Kernel internals may contain provider status text, tool names, or exception
 * details. This module maps those failures to stable user-safe strings.
 *
 * @module
 */

/** Error class used for expected THEORUM contract failures. */
class TheorumError extends Error {
  constructor(message = '', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TheorumError';
  }
}

/** Internal marker for provider or transport failure. */
const UPSTREAM_FAILED = 'upstream failed';
/** Generic safe fallback shown when details must not be surfaced. */
const PUBLIC_GENERIC = 'Something went wrong. Try again.';
/** Safe copy for transient provider unavailability. */
const PUBLIC_UNAVAILABLE = 'The model is unavailable. Try again.';
/** Safe copy for canary or egress disclosure violations. */
const PUBLIC_CANARY = "That reply wasn't safe to show. Try again.";
/** Safe copy for tool or permission denials. */
const PUBLIC_ACTION = "That action isn't available.";
/** Safe copy for unsupported MIME types. */
const PUBLIC_FILE_TYPE = "That file type isn't supported.";
/** Safe copy for oversized files. */
const PUBLIC_FILE_SIZE = 'That file is too large.';
/** Safe copy for too many files in one turn. */
const PUBLIC_FILE_COUNT = 'Too many files for one message.';
/** Safe copy for unsupported generated image dimensions. */
const PUBLIC_IMAGE_SIZE = "That image size isn't supported.";
/** Safe copy when the host aborts a turn. */
const PUBLIC_CANCELLED = 'Cancelled.';

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
  throw new DOMException('The operation was aborted.', 'AbortError');
}

const EXACT: Record<string, string> = {
  [UPSTREAM_FAILED]: PUBLIC_UNAVAILABLE,
  'empty Gemini stream': PUBLIC_UNAVAILABLE,
  'canary leaked': PUBLIC_CANARY,
  'The operation was aborted.': PUBLIC_CANCELLED,
  'This operation was aborted': PUBLIC_CANCELLED,
  'Turn withheld: egress disclosure violation': PUBLIC_CANARY,
  'expected JSON object': 'Something was wrong with that request.',
  'structured output was not valid JSON': 'Something was wrong with that request.',
  'malformed Gemini Live message': PUBLIC_UNAVAILABLE,
  'malformed Gemini Live message during setup': PUBLIC_UNAVAILABLE,
  'user input cannot be placed in the system block': PUBLIC_GENERIC,
  'attachment data must be base64': PUBLIC_FILE_TYPE,
  'attachment is too large': PUBLIC_FILE_SIZE,
  'attachments exceed the per-turn budget': PUBLIC_FILE_SIZE,
  'Tool input validation failed': "That question isn't valid.",
  'This profile does not accept text input': PUBLIC_ACTION,
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
    resolve: () => PUBLIC_UNAVAILABLE,
  },
  {
    match: (t) =>
      t.includes('not enabled on this turn') ||
      t.includes('not allowed') ||
      t.includes('not registered') ||
      t.includes('Unknown model select') ||
      t.includes('Grounding tools'),
    resolve: () => PUBLIC_ACTION,
  },
  {
    match: (t) =>
      t.includes('MIME') ||
      t.includes('does not accept attachments') ||
      t.includes('does not accept voice'),
    resolve: () => PUBLIC_FILE_TYPE,
  },
  {
    match: (t) => t.startsWith('At most'),
    resolve: () => PUBLIC_FILE_COUNT,
  },
  {
    match: (t) =>
      (t.startsWith('Only ') && t.includes('file')) ||
      t.startsWith('Each file must be') ||
      t.startsWith('Those files together'),
    resolve: (t) => t,
  },
  {
    match: (t) => t.includes('attachment'),
    resolve: () => PUBLIC_FILE_SIZE,
  },
  {
    match: (t) => t.includes('aspect or size'),
    resolve: () => PUBLIC_IMAGE_SIZE,
  },
  {
    match: (t) => t.includes('must pin thinking') || t.includes('has no models'),
    resolve: () => PUBLIC_GENERIC,
  },
];

const ALREADY_PUBLIC = new Set([
  PUBLIC_GENERIC,
  PUBLIC_UNAVAILABLE,
  PUBLIC_CANARY,
  PUBLIC_ACTION,
  PUBLIC_FILE_TYPE,
  PUBLIC_FILE_SIZE,
  PUBLIC_FILE_COUNT,
  PUBLIC_IMAGE_SIZE,
  PUBLIC_CANCELLED,
]);

function publicText(text: string): string {
  if (/aborted/i.test(text)) {
    return PUBLIC_CANCELLED;
  }
  if (ALREADY_PUBLIC.has(text)) {
    return text;
  }
  const exact = EXACT[text];
  if (exact) {
    return exact;
  }
  for (const rule of RULES) {
    if (rule.match(text)) {
      return rule.resolve(text);
    }
  }
  return PUBLIC_GENERIC;
}

/** Convert an unknown thrown value or internal message to user-safe text. */
function publicError(err: unknown): string {
  if (isAbortError(err)) {
    return PUBLIC_CANCELLED;
  }
  if (typeof err === 'string') {
    return publicText(err);
  }
  if (err instanceof TheorumError) {
    return publicText(err.message);
  }
  return PUBLIC_UNAVAILABLE;
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
  TheorumError,
  throwIfAborted,
  toErrorEvent,
  UPSTREAM_FAILED,
};
