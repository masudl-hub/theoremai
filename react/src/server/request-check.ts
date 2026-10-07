/**
 * What a browser sends a host, checked: the handler's request bodies and a
 * relay's live messages. A malformed one is a `request` error, which names
 * only the paths and codes that broke, never the value.
 *
 * @module
 */

import { TheoremError, type z } from '@theoremjs/agents';
import {
  type LiveClientMessage,
  type LiveOpenMessage,
  liveClientMessageSchema,
  liveOpenMessageSchema,
} from '../client/live-messages.ts';
import { issueSummary } from '../client/wire-line.ts';

/** `raw` checked against `schema`; a missing or malformed field is a `request` error. */
export function checkRequest<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
    throw new TheoremError('request', `${what} failed its check: ${issueSummary(parsed.error)}`);
  }
  return parsed.data;
}

function liveFrame(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    // lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
    throw new TheoremError('request', 'live message must be JSON', { cause });
  }
}

/**
 * One text frame from the live client, as a relay reads it: JSON that passes
 * `liveClientMessageSchema`, else a `request` error.
 */
export function parseLiveClientMessage(text: string): LiveClientMessage {
  return checkRequest(liveClientMessageSchema, liveFrame(text), 'live message');
}

/**
 * The live client's first frame, as a relay reads it before it opens the
 * session: JSON that passes `liveOpenMessageSchema`, else a `request` error.
 */
export function parseLiveOpenMessage(text: string): LiveOpenMessage {
  // lexicon-exempt: internal diagnostic; the user reads the error kind's wording
  return checkRequest(liveOpenMessageSchema, liveFrame(text), 'live open message');
}
