/**
 * What a browser sends a host, checked: the handler's request bodies and a
 * relay's live messages. A malformed one is a `request` error, which names
 * only the paths and codes that broke, never the value.
 *
 * @module
 */

import { labelText, TheoremError, type z } from '@theoremjs/agents';
import {
  type LiveClientMessage,
  type LiveOpenMessage,
  liveClientMessageSchema,
  liveOpenMessageSchema,
} from '../client/live-messages.ts';
import { issueSummary } from '../client/wire-line.ts';
import { requestByteLimit } from './request-body.ts';

/** `raw` checked against `schema`; a missing or malformed field is a `request` error. */
export function checkRequest<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // labels-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
    throw new TheoremError('request', `${what} failed its check: ${issueSummary(parsed.error)}`);
  }
  return parsed.data;
}

function liveFrame(text: string, maxBytes: number | undefined): unknown {
  const limit = requestByteLimit(maxBytes);
  if (
    limit !== undefined &&
    (text.length > limit || new TextEncoder().encode(text).byteLength > limit)
  )
    throw new TheoremError('request', labelText('error.request'));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // invariant: JSON parser diagnostics can contain browser values.
    throw new TheoremError('request', labelText('error.request'), {
      cause: { code: 'request_json' },
    });
  }
}

/**
 * One text frame from the live client, as a relay reads it: JSON that passes
 * `liveClientMessageSchema`, else a `request` error. A frame over `maxBytes`, when set, is refused.
 */
export function parseLiveClientMessage(text: string, maxBytes?: number): LiveClientMessage {
  return checkRequest(liveClientMessageSchema, liveFrame(text, maxBytes), 'live message');
}

/**
 * The live client's first frame, as a relay reads it before it opens the
 * session: JSON that passes `liveOpenMessageSchema`, else a `request` error. A frame over
 * `maxBytes`, when set, is refused.
 */
export function parseLiveOpenMessage(text: string, maxBytes?: number): LiveOpenMessage {
  // labels-exempt: internal diagnostic; the user reads the error kind's wording
  return checkRequest(liveOpenMessageSchema, liveFrame(text, maxBytes), 'live open message');
}
