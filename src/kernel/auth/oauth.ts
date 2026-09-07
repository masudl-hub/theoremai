/**
 * RFC-compliant OAuth 2.1 discovery and flow orchestration.
 *
 * Implements:
 * - RFC 9728: OAuth 2.0 Protected Resource Metadata
 * - RFC 8414 & OpenID Connect: Authorization Server Metadata
 * - RFC 9207: Authorization Server Issuer Identification
 * - RFC 8707: Resource Indicators
 * - RFC 7636: PKCE (S256)
 *
 * @module
 */

import {
  computeCodeChallenge,
  generateCodeVerifier,
  sealStatePayload,
  unsealStatePayload,
} from './crypto.ts';
import type {
  AuthorizationServerMetadata,
  CreatePkceFlowOptions,
  ExchangePkceCodeOptions,
  ExchangePkceCodeResult,
  OAuth2Credential,
  OAuthTokens,
  PkceFlowResult,
  ProtectedResourceMetadata,
  RefreshOAuthTokenOptions,
} from './types.ts';

/**
 * Discover Protected Resource Metadata (RFC 9728 Section 3).
 * Fetches `/.well-known/oauth-protected-resource`.
 */
export async function discoverResourceMetadata(
  resourceUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<ProtectedResourceMetadata> {
  const origin = new URL(resourceUrl).origin;
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;

  const response = await fetchFn(metadataUrl, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to discover protected resource metadata at ${metadataUrl} (HTTP ${response.status})`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  const authServers = Array.isArray(data.authorization_servers)
    ? (data.authorization_servers as string[])
    : [];

  if (authServers.length === 0) {
    throw new Error(
      `Protected resource metadata at ${metadataUrl} did not declare any authorization_servers`,
    );
  }

  return {
    resource: typeof data.resource === 'string' ? data.resource : resourceUrl,
    authorization_servers: authServers,
    scopes_supported: Array.isArray(data.scopes_supported)
      ? (data.scopes_supported as string[])
      : undefined,
    bearer_methods_supported: Array.isArray(data.bearer_methods_supported)
      ? (data.bearer_methods_supported as string[])
      : undefined,
  };
}

/**
 * Discover Authorization Server Metadata (RFC 8414 Section 3 & OpenID Connect Discovery 1.0).
 * Queries `/.well-known/oauth-authorization-server` then `/.well-known/openid-configuration`.
 */
export async function discoverAuthServerMetadata(
  authServerUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthorizationServerMetadata> {
  const base = authServerUrl.replace(/\/$/, '');
  const paths = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'];

  for (const path of paths) {
    try {
      const response = await fetchFn(`${base}${path}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) continue;

      const data = (await response.json()) as Record<string, unknown>;
      if (
        typeof data.authorization_endpoint === 'string' &&
        typeof data.token_endpoint === 'string'
      ) {
        return {
          issuer: typeof data.issuer === 'string' ? data.issuer : authServerUrl,
          authorization_endpoint: data.authorization_endpoint,
          token_endpoint: data.token_endpoint,
          registration_endpoint:
            typeof data.registration_endpoint === 'string' ? data.registration_endpoint : undefined,
          scopes_supported: Array.isArray(data.scopes_supported)
            ? (data.scopes_supported as string[])
            : undefined,
          response_types_supported: Array.isArray(data.response_types_supported)
            ? (data.response_types_supported as string[])
            : undefined,
          grant_types_supported: Array.isArray(data.grant_types_supported)
            ? (data.grant_types_supported as string[])
            : undefined,
          code_challenge_methods_supported: Array.isArray(data.code_challenge_methods_supported)
            ? (data.code_challenge_methods_supported as string[])
            : undefined,
          authorization_response_iss_parameter_supported:
            data.authorization_response_iss_parameter_supported === true,
          client_id_metadata_document_supported:
            data.client_id_metadata_document_supported === true,
        };
      }
    } catch {
      // Try next discovery endpoint
    }
  }

  throw new Error(`Failed to discover authorization server metadata for "${authServerUrl}"`);
}

/**
 * Initiate an OAuth 2.1 PKCE authorization flow statelesssly.
 *
 * Discovers resource & AS metadata (or uses preResolved), generates PKCE code_verifier/code_challenge,
 * and packs the verifier, expected issuer, and resource into an HMAC-signed state token.
 */
export async function createOAuthPkceFlow(options: CreatePkceFlowOptions): Promise<PkceFlowResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const pre = options.preResolved;

  let issuer = pre?.issuer;
  let authEndpoint = pre?.authorizationEndpoint;
  let resource = pre?.resource;

  if (!authEndpoint || !issuer) {
    let asUrl = options.resourceServerUrl;
    try {
      // 1. Try RFC 9728 discovery on resource server
      const resourceMeta = await discoverResourceMetadata(options.resourceServerUrl, fetchFn);
      resource = resourceMeta.resource;
      asUrl = resourceMeta.authorization_servers[0];
    } catch {
      // If resource discovery fails, treat resourceServerUrl as direct AS URL
      resource = options.resourceServerUrl;
    }

    // 2. Discover AS metadata
    const asMeta = await discoverAuthServerMetadata(asUrl, fetchFn);
    issuer = asMeta.issuer;
    authEndpoint = asMeta.authorization_endpoint;
  }

  // 3. Generate PKCE verifier and S256 challenge
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  // 4. Seal stateless state envelope
  const ttl = options.stateTtlMs ?? 10 * 60 * 1000; // 10 mins
  const state = await sealStatePayload(
    {
      codeVerifier,
      expectedIssuer: issuer,
      resource,
      redirectUri: options.redirectUri,
      expiresAt: Date.now() + ttl,
      clientId: options.clientId,
    },
    options.signingSecret,
  );

  // 5. Construct authorization URL
  const authUrl = new URL(authEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', options.clientId);
  authUrl.searchParams.set('redirect_uri', options.redirectUri);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  if (resource) {
    authUrl.searchParams.set('resource', resource);
  }
  if (options.scopes && options.scopes.length > 0) {
    authUrl.searchParams.set('scope', options.scopes.join(' '));
  }

  return {
    authorizationUrl: authUrl.toString(),
    state,
    codeVerifier,
    codeChallenge,
    issuer,
    resource,
  };
}

/**
 * Validates the authorization response `iss` parameter per RFC 9207 Section 2.4.
 *
 * "The client MUST validate that the 'iss' parameter in the authorization response matches
 * the issuer identifier of the authorization server... using simple string comparison (RFC 3986 Section 6.2.1)."
 */
export function validateIssuer(expectedIssuer: string, receivedIss?: string): void {
  if (!receivedIss) {
    // If not provided, allowed only if AS did not support it, but if provided, must match exactly
    return;
  }
  // Simple byte-exact string comparison (no URL normalization per 2026-07-28 spec)
  if (expectedIssuer !== receivedIss) {
    throw new Error(
      `RFC 9207 Issuer mismatch detected (potential mix-up attack): expected "${expectedIssuer}", received "${receivedIss}"`,
    );
  }
}

/**
 * Exchange authorization code for access and refresh tokens.
 *
 * Verifies state HMAC, performs RFC 9207 `iss` validation, and posts
 * code_verifier and resource to the token_endpoint.
 */
export async function exchangeOAuthPkce(
  options: ExchangePkceCodeOptions,
): Promise<ExchangePkceCodeResult> {
  const fetchFn = options.fetchFn ?? fetch;

  // 1. Unseal state envelope and verify HMAC + expiration
  const statePayload = await unsealStatePayload(options.state, options.signingSecret);

  // Validate redirect_uri matches authorization request per RFC 6749 Section 4.1.3
  const effectiveRedirectUri = options.redirectUri || statePayload.redirectUri;
  if (
    options.redirectUri &&
    statePayload.redirectUri &&
    options.redirectUri !== statePayload.redirectUri
  ) {
    throw new Error(
      `Redirect URI mismatch: expected "${statePayload.redirectUri}", received "${options.redirectUri}"`,
    );
  }

  // 2. Validate RFC 9207 issuer
  validateIssuer(statePayload.expectedIssuer, options.iss);

  // 3. Resolve token endpoint
  let tokenEndpoint = options.tokenEndpoint;
  if (!tokenEndpoint) {
    const asMeta = await discoverAuthServerMetadata(statePayload.expectedIssuer, fetchFn);
    tokenEndpoint = asMeta.token_endpoint;
  }

  // 4. POST to token endpoint
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', options.code);
  body.set('redirect_uri', effectiveRedirectUri);
  body.set('client_id', statePayload.clientId);
  body.set('code_verifier', statePayload.codeVerifier);

  if (statePayload.resource) {
    body.set('resource', statePayload.resource);
  }

  const response = await fetchFn(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Token exchange failed at ${tokenEndpoint} (HTTP ${response.status}): ${errText}`,
    );
  }

  const tokens = (await response.json()) as OAuthTokens;
  const expiresAt =
    tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined;

  const credential: OAuth2Credential = {
    type: 'oauth2',
    issuer: statePayload.expectedIssuer,
    resource: statePayload.resource,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
    tokenEndpoint,
    clientId: statePayload.clientId,
    scope: tokens.scope,
  };

  return { tokens, credential };
}

/**
 * Refresh an expired OAuth 2.1 access token.
 */
export async function refreshOAuthToken(
  options: RefreshOAuthTokenOptions,
): Promise<{ tokens: OAuthTokens; credential: OAuth2Credential }> {
  const fetchFn = options.fetchFn ?? fetch;

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', options.refreshToken);
  body.set('client_id', options.clientId);

  if (options.resource) {
    body.set('resource', options.resource);
  }
  if (options.scope) {
    body.set('scope', options.scope);
  }

  const response = await fetchFn(options.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Token refresh failed at ${options.tokenEndpoint} (HTTP ${response.status}): ${errText}`,
    );
  }

  const tokens = (await response.json()) as OAuthTokens;
  const expiresAt =
    tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined;

  const credential: OAuth2Credential = {
    type: 'oauth2',
    issuer: options.issuer,
    resource: options.resource,
    accessToken: tokens.access_token,
    // Preserve existing refresh token if new one is not issued
    refreshToken: tokens.refresh_token ?? options.refreshToken,
    expiresAt,
    tokenEndpoint: options.tokenEndpoint,
    clientId: options.clientId,
    scope: tokens.scope ?? options.scope,
  };

  return { tokens, credential };
}
