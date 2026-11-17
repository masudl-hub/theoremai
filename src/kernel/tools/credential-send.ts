/**
 * How a tool's credential reaches its service: where it goes on a request, the one hop that
 * carries it, and the credential read out of everything that comes back. A run's own credential
 * source and a sealed one send the same way: the call holds a sender, never the credential.
 *
 * @module
 */

import {
  describeError,
  isAbortError,
  isTimeoutError,
  networkError,
} from '../../guardrails/error.ts';
import { fetchGuarded } from '../../guardrails/network.ts';
import { TheoremError } from '../../guardrails/theorem-error.ts';
import type {
  SealedCredential,
  SealedCredentialSource,
  SealedRequest,
  ToolCredentialSource,
} from '../auth/credential-source.ts';
import { refreshOAuthToken, tokenAudienceCovers } from '../auth/oauth.ts';
import type {
  ApiKeyCredential,
  BearerCredential,
  OAuth2Credential,
  OAuthTransportOptions,
  ToolCredential,
} from '../auth/types.ts';
import type { ToolAuthConfig } from './types.ts';

/** A credential that goes in a query parameter of the URL a call is sent to. */
export type CredentialQuery = { name: string; value: string };

/** Where a slot's credential goes on a request: a header, or the query parameter the tool names. */
export type CredentialPlace = Pick<ToolAuthConfig, 'headerName' | 'headerPrefix' | 'queryParam'>;

/** `url` with the credential set in its query parameter; `url` itself is left as it was. */
export function withCredentialQuery(url: URL, query: CredentialQuery | undefined): URL {
  if (!query) return url;
  const signed = new URL(url);
  signed.searchParams.set(query.name, query.value);
  return signed;
}

function authHeaderPair(
  place: Pick<ToolAuthConfig, 'headerName' | 'headerPrefix'>,
  value: string,
  defaults: { headerName: string; headerPrefix: string },
): Record<string, string> {
  const headerName = place.headerName ?? defaults.headerName;
  const headerPrefix = place.headerPrefix ?? defaults.headerPrefix;
  return { [headerName]: `${headerPrefix}${value}` };
}

/**
 * Where a token or API key goes on a tool's requests: the query parameter the tool names, or a
 * header, `Authorization: Bearer …` for a token and `Authorization: …` for a key unless the tool
 * or the key names another.
 */
export function credentialPlacement(
  place: CredentialPlace,
  credential: BearerCredential | ApiKeyCredential,
): { headers: Record<string, string>; query?: CredentialQuery } {
  const value = credential.type === 'bearer' ? credential.token : credential.key;
  if (place.queryParam !== undefined) {
    return { headers: {}, query: { name: place.queryParam, value } };
  }
  if (credential.type === 'bearer') {
    return {
      headers: authHeaderPair(place, value, {
        headerName: 'Authorization',
        headerPrefix: 'Bearer ',
      }),
    };
  }
  const headerName = credential.headerName ?? place.headerName ?? 'Authorization';
  const headerPrefix = credential.headerPrefix ?? place.headerPrefix ?? '';
  return { headers: { [headerName]: `${headerPrefix}${value}` } };
}

/** The secret a credential carries, and where it goes on a request. */
function placedSecret(
  credential: ToolCredential,
  place: CredentialPlace,
): { headers: Record<string, string>; query?: CredentialQuery; secret: string } {
  if (credential.type === 'oauth2') {
    return {
      headers: authHeaderPair(place, credential.accessToken, {
        headerName: 'Authorization',
        headerPrefix: 'Bearer ',
      }),
      secret: credential.accessToken,
    };
  }
  const secret = credential.type === 'bearer' ? credential.token : credential.key;
  return { ...credentialPlacement(place, credential), secret };
}

const OMIT_CREDENTIAL = '[omitted - credential]';

/**
 * Every form a service may echo a secret in, longest first: as sent, escaped in a JSON string
 * (`/` as it is and as `\/`), and URL-encoded (as a component, with lowercase hex, and as a form).
 */
function secretForms(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  const component = encodeURIComponent(secret);
  const forms = new Set([
    secret,
    json,
    json.replaceAll('/', '\\/'),
    component,
    component.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
    new URLSearchParams([['', secret]]).toString().slice(1),
  ]);
  forms.delete('');
  return [...forms].sort((a, b) => b.length - a.length);
}

function escapedForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces the secret, in every form {@link secretForms} names, wherever a text holds it. */
function secretOmitter(secret: string): (text: string) => string {
  const forms = secretForms(secret);
  if (forms.length === 0) return (text) => text;
  const pattern = new RegExp(forms.map(escapedForPattern).join('|'), 'g');
  return (text) => text.replace(pattern, OMIT_CREDENTIAL);
}

/** The form of the secret `bytes` holds at `at`, longest first, or `undefined`. */
function formAt(
  bytes: Uint8Array,
  at: number,
  forms: readonly Uint8Array[],
): Uint8Array | undefined {
  return forms.find((form) => {
    if (at + form.length > bytes.length) return false;
    for (let i = 0; i < form.length; i++) {
      if (bytes[at + i] !== form[i]) return false;
    }
    return true;
  });
}

/**
 * A body with the secret, in every form {@link secretForms} names, replaced as it arrives. The
 * last `longest form - 1` bytes wait for the next piece, so a secret split across pieces is whole
 * when it is replaced. Bytes, not text, so a body that is not text arrives as it was sent.
 */
function bodyWithoutSecret(
  body: ReadableStream<Uint8Array>,
  secret: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const forms = secretForms(secret).map((form) => encoder.encode(form));
  const held = Math.max(0, ...forms.map((form) => form.length - 1));
  const omitted = encoder.encode(OMIT_CREDENTIAL);
  let pending = new Uint8Array(0);
  /** Replaces every whole secret in `pending`; sends all of it but the tail a secret may start in. */
  const release = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
    const stop = final ? pending.length : pending.length - held;
    let sent = 0;
    let at = 0;
    while (at < stop) {
      const form = formAt(pending, at, forms);
      if (form) {
        if (at > sent) controller.enqueue(pending.slice(sent, at));
        controller.enqueue(omitted.slice());
        at += form.length;
        sent = at;
      } else {
        at++;
      }
    }
    if (at > sent) controller.enqueue(pending.slice(sent, at));
    pending = pending.slice(at);
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(piece, controller) {
        const joined = new Uint8Array(pending.length + piece.length);
        joined.set(pending);
        joined.set(piece, pending.length);
        pending = joined;
        release(controller, false);
      },
      flush(controller) {
        release(controller, true);
      },
    }),
  );
}

/** Statuses whose answers have no body (Fetch standard). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** An answer with the credential replaced in every header (a redirect's `Location` too) and in its body. */
function answerWithoutSecret(response: Response, secret: string): Response {
  const omit = secretOmitter(secret);
  const headers = new Headers();
  // why: `append`, so each `Set-Cookie` the service sent is kept.
  for (const [name, value] of response.headers) headers.append(name, omit(value));
  // why: a replaced credential changes the body's length.
  headers.delete('content-length');
  const body =
    response.body && !NULL_BODY_STATUSES.has(response.status)
      ? bodyWithoutSecret(response.body, secret)
      : null;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * A failed send's error, named as `networkError` names it, with the credential replaced: a URL
 * that carried it is named nowhere, and no cause that might hold it is kept.
 */
function errorWithoutSecret(err: unknown, secret: string): unknown {
  if (isAbortError(err) || isTimeoutError(err)) return err;
  const named = networkError(err);
  const kind = named instanceof TheoremError ? named.kind : 'network';
  return new TheoremError(kind, secretOmitter(secret)(describeError(named)));
}

/** The URL a fetch was asked for; a sender takes a URL, never a `Request`, whose body it could not read again. */
function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) {
    throw new TheoremError('internal', 'A credential sender takes a URL, not a Request'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return new URL(input);
}

/**
 * A fetch that sends one hop with `credential` placed as `place` says, and answers with it
 * replaced wherever the service echoed it: headers, body, and a thrown error's message. It never
 * follows a redirect; the caller clears each hop and sends only its origin's hops through here.
 */
export function credentialSender(
  credential: ToolCredential,
  place: CredentialPlace,
  fetchFn: typeof fetch = fetch,
): typeof fetch {
  const placed = placedSecret(credential, place);
  return async (input, init) => {
    const url = withCredentialQuery(requestUrl(input), placed.query);
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(placed.headers)) headers.set(name, value);
    let response: Response;
    try {
      response = await fetchFn(url.href, { ...init, headers, redirect: 'manual' });
    } catch (err) {
      throw errorWithoutSecret(err, placed.secret);
    }
    return answerWithoutSecret(response, placed.secret);
  };
}

/**
 * Replaces `credential`'s secret wherever a text holds it, in each form a service may echo it in.
 * For a credential the run holds, whose code (a function tool's handler) could repeat it.
 */
export function credentialOmitter(credential: ToolCredential): (text: string) => string {
  return secretOmitter(placedSecret(credential, {}).secret);
}

/** One stable name for a credential: a digest of its secret, which never leaves the sender's side. */
export async function credentialId(credential: ToolCredential): Promise<string> {
  const secret = placedSecret(credential, {}).secret;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Refreshes in flight, by grant. Calls that find the same expired token share
 * one refresh: with rotating refresh tokens a second request would present a
 * spent token, which a server may treat as theft and revoke the whole grant.
 */
const refreshesInFlight = new Map<string, Promise<OAuth2Credential>>();

function refreshOnce(
  credential: OAuth2Credential,
  refreshToken: string,
  transport: OAuthTransportOptions,
  clientSecret: string | undefined,
): Promise<OAuth2Credential> {
  const grant = `${credential.tokenEndpoint}\n${refreshToken}`;
  const inFlight = refreshesInFlight.get(grant);
  if (inFlight) return inFlight;
  const refresh = refreshOAuthToken({
    refreshToken,
    tokenEndpoint: credential.tokenEndpoint,
    clientId: credential.clientId,
    resource: credential.resource,
    scope: credential.scope,
    issuer: credential.issuer,
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...transport,
  }).then((result) => result.credential);
  refreshesInFlight.set(grant, refresh);
  const settle = () => refreshesInFlight.delete(grant);
  refresh.then(settle, settle);
  return refresh;
}

/** A stored credential made ready to send: an expired OAuth token refreshed and stored, or why it cannot go. */
export type CredentialReadiness =
  | { state: 'ready'; credential: ToolCredential; refreshed: boolean }
  | {
      state: 'unusable';
      /**
       * - `no_resource`: an OAuth token that names no resource has nowhere it may go.
       * - `expired`: an OAuth token past its time, with no refresh token.
       * - `refresh_failed`: the token server refused or failed the refresh.
       */
      reason: 'no_resource' | 'expired' | 'refresh_failed';
      /** The token server's own words, for `refresh_failed`: untrusted, for the host only. */
      detail?: string;
    };

/**
 * `credential` ready to send. An OAuth token within 30 seconds of its expiry is refreshed, and the
 * new one stored in `source` before this resolves.
 */
export async function readyCredential(
  slot: string,
  credential: ToolCredential,
  source: ToolCredentialSource,
  transport: OAuthTransportOptions,
): Promise<CredentialReadiness> {
  if (credential.type !== 'oauth2') return { state: 'ready', credential, refreshed: false };
  // invariant: A token goes only to the resource it was issued for; one that names none
  // has nowhere it may go, so the user signs in again.
  if (typeof credential.resource !== 'string' || credential.resource.length === 0) {
    return { state: 'unusable', reason: 'no_resource' };
  }
  const isExpired =
    credential.expiresAt !== undefined && credential.expiresAt <= Date.now() + 30000;
  if (!isExpired) return { state: 'ready', credential, refreshed: false };
  if (!credential.refreshToken) return { state: 'unusable', reason: 'expired' };
  const clientSecret = await source.clientSecret?.(credential.clientId);
  let refreshed: OAuth2Credential;
  try {
    refreshed = await refreshOnce(credential, credential.refreshToken, transport, clientSecret);
  } catch (err) {
    // why: a token server's error can repeat what it was sent; none of it leaves this side.
    const sent = [credential.accessToken, credential.refreshToken, clientSecret];
    const detail = sent.reduce<string>(
      (text, secret) => (secret ? secretOmitter(secret)(text) : text),
      err instanceof Error ? err.message : String(err),
    );
    return { state: 'unusable', reason: 'refresh_failed', detail };
  }
  // why: The host persists the refreshed credential before the call goes on; a rotated refresh
  // token lost to a closed stream cannot be recovered.
  await source.set(slot, refreshed);
  return { state: 'ready', credential: refreshed, refreshed: true };
}

/** Where a sealed slot's credential may go, and where on a request. */
export interface SealedSlot extends CredentialPlace {
  /**
   * The https URL the credential is for: its origin, and its path or below it (as RFC 8707). A
   * request anywhere else is refused before the credential is read, whatever its type.
   */
  resource: string;
}

/** Options for {@link sealedCredentialHost}. */
export interface SealedCredentialHostOptions extends OAuthTransportOptions {
  /** Where the credentials are kept, in plaintext; only this side reads it. */
  source: ToolCredentialSource;
  /** Every slot this host sends for. A slot not named here is refused. */
  slots: Readonly<Record<string, SealedSlot>>;
}

function sealedSlot(slots: Readonly<Record<string, SealedSlot>>, slot: string): SealedSlot {
  const found = Object.hasOwn(slots, slot) ? slots[slot] : undefined;
  if (!found) throw new TheoremError('config', `No sealed slot '${slot}'`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  return found;
}

/**
 * The side of a sealed credential source that holds the credentials: run it where the run's code
 * cannot reach, and pass the run a source that forwards `prepare` and `send` to it. It readies a
 * credential as a run's own source would (refresh, stored), sends a request only to the slot's
 * resource and, for an OAuth token, the resource it was issued for, checks each request against
 * the network policy, and answers with the credential replaced wherever the service echoed it.
 */
export function sealedCredentialHost(options: SealedCredentialHostOptions): SealedCredentialSource {
  const { source, slots, ...transport } = options;
  return {
    sealed: true,
    async prepare(slot): Promise<SealedCredential> {
      const place = sealedSlot(slots, slot);
      const stored = await source.get(slot);
      if (!stored) return { state: 'absent' };
      const bound =
        stored.type === 'oauth2' ? { issuer: stored.issuer, resource: stored.resource } : {};
      const ready = await readyCredential(slot, stored, source, transport);
      if (ready.state === 'unusable') return { ...ready, ...bound };
      return {
        state: 'ready',
        id: await credentialId(ready.credential),
        refreshed: ready.refreshed,
        resource: ready.credential.type === 'oauth2' ? ready.credential.resource : place.resource,
        ...bound,
      };
    },
    async send(slot: string, url: string, request: SealedRequest): Promise<Response> {
      const place = sealedSlot(slots, slot);
      const target = new URL(url);
      if (!tokenAudienceCovers(place.resource, target)) {
        throw new TheoremError(
          'blocked',
          `The credential for slot '${slot}' cannot be sent to "${target.origin}${target.pathname}"`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        );
      }
      const credential = await source.get(slot);
      if (!credential) {
        throw new TheoremError('auth', `Slot '${slot}' holds no credential`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      }
      if (credential.type === 'oauth2' && !tokenAudienceCovers(credential.resource, target)) {
        throw new TheoremError(
          'blocked',
          `The OAuth token for "${credential.resource}" cannot be sent to "${target.origin}${target.pathname}"`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        );
      }
      return await fetchGuarded(
        url,
        {
          method: request.method,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          ...(request.signal ? { signal: request.signal } : {}),
        },
        {
          policy: transport.network,
          followRedirects: false,
          resolveHost: transport.resolveHost,
          fetchFn: credentialSender(credential, place, transport.fetchFn),
        },
      );
    },
  };
}
