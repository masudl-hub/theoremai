import { TheoremError } from '../../guardrails/error.ts';
import type { ToolAuthType } from '../schema.ts';
import type { ApiKeyCredential, BearerCredential } from './types.ts';

/**
 * The server builds the credential, so the browser cannot pick its kind or header. An OAuth
 * gate takes no typed secret: its token comes from the host's callback route.
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

/** `auth` is absent on any gate other than sign-in, which takes no key. */
export function credentialForSignInGate(
  auth: { slot: string; authType: ToolAuthType } | undefined,
  secret: unknown,
): { slot: string; credential: BearerCredential | ApiKeyCredential } {
  if (!auth) {
    throw new TheoremError('request', 'a typed credential answers only a sign-in gate'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return { slot: auth.slot, credential: credentialFromTypedSecret(auth.authType, secret) };
}
