/**
 * A key or token the user typed at a sign-in gate, made into the credential
 * the gate's slot waits for. The server builds it: the browser sends only the
 * text, so it can't pick the credential's kind or the header it rides in.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import type { ToolAuthType } from '../schema.ts';
import type { ApiKeyCredential, BearerCredential } from './types.ts';

/**
 * The credential for a typed `secret` at a gate of `authType`. An OAuth gate
 * takes no typed secret: its token comes from the host's callback route.
 */
export function credentialFromTypedSecret(
  authType: ToolAuthType,
  secret: unknown,
): BearerCredential | ApiKeyCredential {
  const value = typeof secret === 'string' ? secret.trim() : '';
  if (!value) {
    throw new TheoremError('request', 'A typed credential must be a non-empty string'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (authType === 'bearer') return { type: 'bearer', token: value };
  if (authType === 'api_key') return { type: 'api_key', key: value };
  throw new TheoremError(
    'request',
    `A '${authType}' sign-in takes no typed credential; the host's callback saves it`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}
