/**
 * The signed-in fetch a function tool with `auth` gets as `ctx.signedInFetch`.
 * The kernel holds the credential; the handler only makes requests that carry it.
 *
 * @module
 */

import { fetchGuarded } from '../../guardrails/network.ts';
import { TheoremError } from '../../guardrails/theorem-error.ts';
import type { RequestChecks } from './events.ts';
import { toolNetworkPolicy } from './events.ts';
import {
  audienceMismatch,
  type CredentialRefusal,
  credentialRefusal,
  refusalAsksForSignIn,
} from './remote.ts';
import type { SignedInFetch, ToolContext } from './types.ts';

/** Thrown by a signed-in fetch when the service refuses the credential; the kernel settles it. */
export class CredentialRefusedError extends Error {
  readonly refusal: CredentialRefusal;

  constructor(refusal: CredentialRefusal) {
    super(`The service refused the credential (HTTP ${refusal.status}).`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    this.name = 'CredentialRefusedError';
    this.refusal = refusal;
  }
}

export function signedInFetch(
  prepared: { authHeaders: Record<string, string>; audience?: string },
  ctx: ToolContext,
  checks: RequestChecks,
): SignedInFetch {
  return async (url, request = {}) => {
    const target = new URL(url);
    const mismatch = audienceMismatch(prepared.audience, target);
    if (mismatch) throw new TheoremError('config', mismatch);
    const response = await fetchGuarded(
      target.href,
      {
        method: request.method ?? 'GET',
        headers: request.headers,
        body: request.body,
        signal: ctx.signal,
      },
      {
        policy: toolNetworkPolicy(ctx),
        followRedirects: true,
        originBoundHeaders: prepared.authHeaders,
        resolveHost: ctx.resolveHost,
        onCheck: checks.onCheck,
      },
    );
    const refusal = credentialRefusal(response);
    if (refusal && refusalAsksForSignIn(refusal)) {
      await response.body?.cancel();
      throw new CredentialRefusedError(refusal);
    }
    return response;
  };
}
