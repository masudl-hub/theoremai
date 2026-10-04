import { fetchGuarded } from '../../guardrails/network.ts';
import { isRecord } from '../util/record.ts';
import {
  computeCodeChallenge,
  generateCodeVerifier,
  sealStatePayload,
  toBase64Url,
  unsealStatePayload,
} from './crypto.ts';
import type {
  AuthorizationServerMetadata,
  CreatePkceFlowOptions,
  ExchangePkceCodeOptions,
  ExchangePkceCodeResult,
  OAuth2Credential,
  OAuthEndpoints,
  OAuthTokens,
  OAuthTransportOptions,
  PkceFlowResult,
  ProtectedResourceMetadata,
  RefreshOAuthTokenOptions,
} from './types.ts';

const HTTP_NOT_FOUND = 404;

/** Never follows a redirect: it would carry codes and refresh tokens somewhere nobody vetted. */
function oauthFetch(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
  transport: OAuthTransportOptions,
): Promise<Response> {
  return fetchGuarded(url, init, {
    policy: transport.network,
    followRedirects: false,
    resolveHost: transport.resolveHost,
    ...(transport.fetchFn ? { fetchFn: transport.fetchFn } : {}),
  });
}

/** RFC 8414 §2, RFC 9728 §1.2, OAuth 2.1 §1.5: an absolute `https` URL without a fragment. */
function httpsUrl(value: unknown, what: string): URL {
  if (typeof value !== 'string') {
    throw new Error(`OAuth ${what} is missing`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OAuth ${what} "${value}" is not a URL`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (url.protocol !== 'https:' || url.hash) {
    throw new Error(`OAuth ${what} "${value}" must be an https URL without a fragment`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return url;
}

/** RFC 8252 §7.3: the loopback hosts an `http` redirect may name. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * RFC 6749 §3.1.2: no fragment; `https`, `http` on loopback (RFC 8252 §7.3), or a
 * reverse-domain private-use scheme for a native app (RFC 8252 §7.1).
 */
function assertRedirectUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OAuth redirect_uri "${value}" is not an absolute URI`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const scheme = url.protocol.slice(0, -1);
  const allowed =
    scheme === 'https' ||
    (scheme === 'http' && LOOPBACK_HOSTS.has(url.hostname)) ||
    (scheme !== 'http' && scheme.includes('.'));
  if (!allowed || value.includes('#')) {
    throw new Error(
      `OAuth redirect_uri "${value}" must be https, http on loopback, or a reverse-domain app scheme, without a fragment`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** RFC 6749 §3.3: a scope token is one or more printable ASCII characters other than space, `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

function assertScopeTokens(scopes: readonly string[]): void {
  for (const scope of scopes) {
    if (!SCOPE_TOKEN.test(scope)) {
      throw new Error(`OAuth scope "${scope}" is not a single RFC 6749 scope token`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  }
}

/** Names the flow sets itself; a provider's own parameters may not replace them. */
const FLOW_PARAMS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'resource',
  'scope',
]);

function assertAuthorizationParams(params: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(params)) {
    if (FLOW_PARAMS.has(name)) {
      throw new Error(
        `OAuth authorization parameter "${name}" is set by the flow and cannot be passed`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

/** A client id that is a URL is a Client ID Metadata Document, which is served over https. */
function assertClientId(clientId: string): void {
  if (clientId.length === 0) {
    throw new Error('OAuth client_id is missing'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (/^https?:/i.test(clientId)) httpsUrl(clientId, 'client_id');
}

/** RFC 8414 §3.1, RFC 9728 §3.1: `/.well-known/<suffix>` goes between the host and the path. */
function wellKnownUrl(identifier: URL, suffix: string): string {
  const path = identifier.pathname.replace(/\/$/, '');
  return `${identifier.origin}/.well-known/${suffix}${path}${identifier.search}`;
}

function stringList(data: Record<string, unknown>, field: string): string[] | undefined {
  const value = data[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`OAuth metadata "${field}" must be a list of strings`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return value;
}

async function metadataObject(response: Response, url: string): Promise<Record<string, unknown>> {
  const data: unknown = await response.json();
  if (!isRecord(data)) {
    throw new Error(`OAuth metadata at ${url} is not a JSON object`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return data;
}

/** `undefined` on HTTP 404. RFC 9728 §3.3: a `resource` not identical to `resourceUrl` is refused. */
export async function discoverResourceMetadata(
  resourceUrl: string,
  transport: OAuthTransportOptions = {},
): Promise<ProtectedResourceMetadata | undefined> {
  const metadataUrl = wellKnownUrl(httpsUrl(resourceUrl, 'resource'), 'oauth-protected-resource');
  const response = await oauthFetch(
    metadataUrl,
    { headers: { Accept: 'application/json' } },
    transport,
  );
  if (response.status === HTTP_NOT_FOUND) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Failed to discover protected resource metadata at ${metadataUrl} (HTTP ${response.status})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }

  const data = await metadataObject(response, metadataUrl);
  if (data.resource !== resourceUrl) {
    throw new Error(
      `Protected resource metadata at ${metadataUrl} is for "${String(data.resource)}", not "${resourceUrl}"`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const authServers = stringList(data, 'authorization_servers') ?? [];
  if (authServers.length === 0) {
    throw new Error(
      `Protected resource metadata at ${metadataUrl} did not declare any authorization_servers`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  for (const server of authServers) httpsUrl(server, 'authorization server');

  return {
    resource: resourceUrl,
    authorization_servers: authServers,
    scopes_supported: stringList(data, 'scopes_supported'),
    bearer_methods_supported: stringList(data, 'bearer_methods_supported'),
  };
}

/** RFC 8414 §3.3: the `issuer` must be identical to the one it was fetched for. */
function parseAuthServerMetadata(
  data: Record<string, unknown>,
  issuer: string,
  url: string,
): AuthorizationServerMetadata {
  if (data.issuer !== issuer) {
    throw new Error(
      `Authorization server metadata at ${url} names issuer "${String(data.issuer)}", not "${issuer}"`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const authorizationEndpoint = httpsUrl(data.authorization_endpoint, 'authorization_endpoint');
  const tokenEndpoint = httpsUrl(data.token_endpoint, 'token_endpoint');
  const registrationEndpoint =
    data.registration_endpoint === undefined
      ? undefined
      : httpsUrl(data.registration_endpoint, 'registration_endpoint');
  return {
    issuer,
    authorization_endpoint: authorizationEndpoint.href,
    token_endpoint: tokenEndpoint.href,
    registration_endpoint: registrationEndpoint?.href,
    scopes_supported: stringList(data, 'scopes_supported'),
    response_types_supported: stringList(data, 'response_types_supported'),
    grant_types_supported: stringList(data, 'grant_types_supported'),
    code_challenge_methods_supported: stringList(data, 'code_challenge_methods_supported'),
    authorization_response_iss_parameter_supported:
      data.authorization_response_iss_parameter_supported === true,
    client_id_metadata_document_supported: data.client_id_metadata_document_supported === true,
  };
}

/** In order: RFC 8414, then OIDC Discovery with the well-known inserted, then appended for a path. */
function authServerMetadataUrls(issuer: URL): string[] {
  const urls = [
    wellKnownUrl(issuer, 'oauth-authorization-server'),
    wellKnownUrl(issuer, 'openid-configuration'),
  ];
  const path = issuer.pathname.replace(/\/$/, '');
  if (path) urls.push(`${issuer.origin}${path}/.well-known/openid-configuration`);
  return urls;
}

/** A non-OK URL moves on to the next; metadata that answers but fails validation is refused outright. */
export async function discoverAuthServerMetadata(
  issuer: string,
  transport: OAuthTransportOptions = {},
): Promise<AuthorizationServerMetadata> {
  const issuerUrl = httpsUrl(issuer, 'issuer');
  if (issuerUrl.search) {
    throw new Error(`OAuth issuer "${issuer}" must not have a query`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  for (const url of authServerMetadataUrls(issuerUrl)) {
    const response = await oauthFetch(url, { headers: { Accept: 'application/json' } }, transport);
    if (!response.ok) {
      await response.body?.cancel();
      continue;
    }
    return parseAuthServerMetadata(await metadataObject(response, url), issuer, url);
  }
  throw new Error(`Failed to discover authorization server metadata for "${issuer}"`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
}

/** A resource that publishes no metadata is its own authorization server. */
async function discoverEndpoints(
  resourceServerUrl: string,
  transport: OAuthTransportOptions,
): Promise<OAuthEndpoints> {
  const resourceMeta = await discoverResourceMetadata(resourceServerUrl, transport);
  const issuer = resourceMeta?.authorization_servers[0] ?? resourceServerUrl;
  const asMeta = await discoverAuthServerMetadata(issuer, transport);
  if (!asMeta.code_challenge_methods_supported?.includes('S256')) {
    throw new Error(
      `Authorization server "${issuer}" does not advertise S256 PKCE (code_challenge_methods_supported)`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  return {
    issuer: asMeta.issuer,
    authorizationEndpoint: asMeta.authorization_endpoint,
    tokenEndpoint: asMeta.token_endpoint,
    issParameterSupported: asMeta.authorization_response_iss_parameter_supported === true,
  };
}

/** Stateless: the verifier, expected issuer, token endpoint and resource are sealed into `state`. */
export async function createOAuthPkceFlow(options: CreatePkceFlowOptions): Promise<PkceFlowResult> {
  const endpoints =
    options.preResolved ?? (await discoverEndpoints(options.resourceServerUrl, options));
  httpsUrl(endpoints.issuer, 'issuer');
  const authUrl = httpsUrl(endpoints.authorizationEndpoint, 'authorization_endpoint');
  const tokenEndpoint = httpsUrl(endpoints.tokenEndpoint, 'token_endpoint').href;
  const { issuer } = endpoints;
  // RFC 8707 audience: always the resource the flow is for; discovery required its metadata to match.
  httpsUrl(options.resourceServerUrl, 'resource');
  const resource = options.resourceServerUrl;
  assertClientId(options.clientId);
  assertRedirectUri(options.redirectUri);
  if (options.scopes) assertScopeTokens(options.scopes);
  if (options.authorizationParams) assertAuthorizationParams(options.authorizationParams);
  const ttl = options.stateTtlMs ?? 10 * 60 * 1000;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new RangeError(`OAuth stateTtlMs must be a positive number of milliseconds; got ${ttl}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }

  const sessionBinding = await sessionBindingDigest(options.sessionBinding);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  const state = await sealStatePayload(
    {
      codeVerifier,
      expectedIssuer: issuer,
      issRequired: endpoints.issParameterSupported === true,
      tokenEndpoint,
      resource,
      redirectUri: options.redirectUri,
      expiresAt: Date.now() + ttl,
      clientId: options.clientId,
      sessionBinding,
      scopes: options.scopes ? [...options.scopes] : [],
    },
    options.signingSecret,
  );

  for (const [name, value] of Object.entries(options.authorizationParams ?? {})) {
    authUrl.searchParams.set(name, value);
  }
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', options.clientId);
  authUrl.searchParams.set('redirect_uri', options.redirectUri);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  authUrl.searchParams.set('resource', resource);
  if (options.scopes && options.scopes.length > 0) {
    authUrl.searchParams.set('scope', options.scopes.join(' '));
  }

  return {
    authorizationUrl: authUrl.toString(),
    state,
    codeChallenge,
    issuer,
    resource,
  };
}

/** SHA-256 of the host's session binding, so the raw value never enters the state. */
async function sessionBindingDigest(binding: string): Promise<string> {
  if (binding.length === 0) {
    throw new Error('OAuth sessionBinding must be a non-empty value tied to the user session'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(binding));
  return toBase64Url(new Uint8Array(digest));
}

/** Compare two digests without an early exit, so timing says nothing about where they differ. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** RFC 9207 §2.4: `iss` is required when the server advertises it, and byte-exact (no URL normalization). */
export function validateIssuer(
  expectedIssuer: string,
  receivedIss: string | undefined,
  issRequired: boolean,
): void {
  if (receivedIss === undefined) {
    if (issRequired) {
      throw new Error(
        `RFC 9207: authorization server "${expectedIssuer}" sends "iss", but the response has none (potential mix-up attack)`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return;
  }
  if (expectedIssuer !== receivedIss) {
    throw new Error(
      `RFC 9207 Issuer mismatch detected (potential mix-up attack): expected "${expectedIssuer}", received "${receivedIss}"`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** RFC 6749 §5.2: `error_description` is printable ASCII without `"` or `\`. */
const ERROR_DESCRIPTION = /^[\x20\x21\x23-\x5B\x5D-\x7E]*$/;

/** RFC 6749 §5.2 shape only; any other body is not repeated into the error. */
async function tokenErrorText(response: Response): Promise<string> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return '';
  }
  if (!isRecord(data)) return '';
  const { error, error_description: description } = data;
  if (typeof error !== 'string' || !ERROR_DESCRIPTION.test(error)) return '';
  const told = typeof description === 'string' && ERROR_DESCRIPTION.test(description);
  return told ? `: ${error} (${description})` : `: ${error}`;
}

function parseTokenResponse(data: unknown, tokenEndpoint: string): OAuthTokens {
  const fail = (why: string): never => {
    throw new Error(`Token response from ${tokenEndpoint} ${why}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
  if (!isRecord(data)) {
    return fail('is not a JSON object'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const tokens = data;
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    fail('has no access_token'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer') {
    fail(`has token_type "${String(tokens.token_type)}", not Bearer`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const expiresIn = tokens.expires_in;
  if (
    expiresIn !== undefined &&
    (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn < 0)
  ) {
    fail('has an expires_in that is not a number of seconds'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  for (const field of ['refresh_token', 'scope'] as const) {
    if (tokens[field] !== undefined && typeof tokens[field] !== 'string') {
      fail(`has a ${field} that is not a string`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  }
  return tokens as OAuthTokens;
}

/**
 * Who a token is for and where it came from; fixed by the flow, never by the token response.
 * `clientSecret` authenticates a confidential client and is never put on the credential.
 */
type TokenGrant = Pick<OAuth2Credential, 'issuer' | 'resource' | 'tokenEndpoint' | 'clientId'> & {
  clientSecret?: string;
};

/** RFC 6749 §3.3: a scope is a list of space-delimited tokens. */
function scopeTokens(scope: string | undefined): string[] {
  return scope === undefined ? [] : scope.split(' ').filter((token) => token.length > 0);
}

/**
 * The scopes asked for are the most a grant may hold: a token carrying any other is refused
 * before it is stored. An empty request asked for the server's default, so it sets no ceiling;
 * a response without `scope` granted exactly what was asked (RFC 6749 §5.1).
 */
function assertGrantWithin(
  granted: string | undefined,
  requested: readonly string[],
  tokenEndpoint: string,
): void {
  if (requested.length === 0) return;
  const beyond = scopeTokens(granted).filter((scope) => !requested.includes(scope));
  if (beyond.length > 0) {
    throw new Error(
      `Token response from ${tokenEndpoint} grants scopes that were not asked for: ${beyond.join(', ')}`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/**
 * `requested` is the ceiling the grant is held to. A refresh passes `previous`, whose refresh
 * token and scope stay when the server sends no new ones.
 */
async function requestToken(
  transport: OAuthTransportOptions,
  grant: TokenGrant,
  params: Record<string, string>,
  requested: readonly string[],
  previous?: { refreshToken: string; scope?: string },
): Promise<ExchangePkceCodeResult> {
  const { clientSecret, ...issued } = grant;
  const body = new URLSearchParams({
    ...params,
    client_id: grant.clientId,
    ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
    resource: grant.resource,
  });
  const response = await oauthFetch(
    grant.tokenEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    },
    transport,
  );
  if (!response.ok) {
    const failed = previous ? 'Token refresh failed' : 'Token exchange failed'; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    throw new Error(
      `${failed} at ${grant.tokenEndpoint} (HTTP ${response.status})${await tokenErrorText(response)}`,
    );
  }
  const tokens = parseTokenResponse(await response.json(), grant.tokenEndpoint);
  assertGrantWithin(tokens.scope, requested, grant.tokenEndpoint);
  const credential: OAuth2Credential = {
    type: 'oauth2',
    ...issued,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken,
    expiresAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000,
    scope:
      tokens.scope ?? previous?.scope ?? (requested.length > 0 ? requested.join(' ') : undefined),
  };
  return { tokens, credential };
}

/**
 * Requires the session that began the flow (RFC 6749 §10.12), the same `redirect_uri` (§4.1.3)
 * and a valid `iss` (RFC 9207); posts to the token endpoint sealed in `state`, never a caller's.
 */
export async function exchangeOAuthPkce(
  options: ExchangePkceCodeOptions,
): Promise<ExchangePkceCodeResult> {
  const state = await unsealStatePayload(options.state, options.signingSecret);
  const presented = await sessionBindingDigest(options.sessionBinding);
  if (!sameDigest(presented, state.sessionBinding)) {
    throw new Error(
      'OAuth state belongs to another session: the callback did not come from the session that began the flow', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (options.redirectUri !== state.redirectUri) {
    throw new Error(
      `Redirect URI mismatch: expected "${state.redirectUri}", received "${options.redirectUri}"`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  validateIssuer(state.expectedIssuer, options.iss, state.issRequired);

  return requestToken(
    options,
    {
      issuer: state.expectedIssuer,
      resource: state.resource,
      tokenEndpoint: state.tokenEndpoint,
      clientId: state.clientId,
      ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
    },
    {
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: state.redirectUri,
      code_verifier: state.codeVerifier,
    },
    state.scopes,
  );
}

/** Exchanges a refresh token for new tokens at the token endpoint; both the endpoint and the resource must be https URLs. */
export function refreshOAuthToken(
  options: RefreshOAuthTokenOptions,
): Promise<ExchangePkceCodeResult> {
  httpsUrl(options.tokenEndpoint, 'token_endpoint');
  httpsUrl(options.resource, 'resource');
  return requestToken(
    options,
    {
      issuer: options.issuer,
      resource: options.resource,
      tokenEndpoint: options.tokenEndpoint,
      clientId: options.clientId,
      ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
    },
    {
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
      ...(options.scope ? { scope: options.scope } : {}),
    },
    scopeTokens(options.scope),
    { refreshToken: options.refreshToken, scope: options.scope },
  );
}

/** RFC 8707: the same origin, and the resource's path or below it. */
export function tokenAudienceCovers(resource: string, url: URL): boolean {
  let audience: URL;
  try {
    audience = new URL(resource);
  } catch {
    return false;
  }
  if (audience.origin !== url.origin) return false;
  const base = audience.pathname.replace(/\/$/, '');
  return url.pathname === base || url.pathname.startsWith(`${base}/`) || base === '';
}
