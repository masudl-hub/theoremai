/**
 * OAuth 2.1 and Model Context Protocol authorization types.
 *
 * Implements current July 28, 2026 MCP specification requirements:
 * - RFC 9728: Protected Resource Metadata
 * - RFC 8414 & OpenID Connect: Authorization Server Metadata
 * - RFC 9207: Authorization Server Issuer Identification (`iss` validation)
 * - RFC 8707: Resource Indicators
 * - RFC 7636: PKCE with S256
 *
 * @module
 */

import type { ResolveHost } from '../../guardrails/network.ts';
import type { NetworkGuardrailSpec } from '../../guardrails/types.ts';

/** RFC 9728 Protected Resource Metadata */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_documentation?: string;
  [key: string]: unknown;
}

/** RFC 8414 / OpenID Connect Discovery Metadata */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
  client_id_metadata_document_supported?: boolean;
  [key: string]: unknown;
}

/** Standard OAuth 2.1 token response */
export interface OAuthTokens {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  /** Custom extra parameters returned by AS */
  [key: string]: unknown;
}

/** Normalized OAuth credential for storage / pass-through in TurnRequest */
export interface OAuth2Credential {
  type: 'oauth2';
  issuer: string;
  /** The resource (RFC 8707) the token was issued for; it is sent nowhere else. */
  resource: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch timestamp in ms
  tokenEndpoint: string;
  clientId: string;
  scope?: string;
}

/** Bearer token credential */
export interface BearerCredential {
  type: 'bearer';
  token: string;
}

/** API key credential */
export interface ApiKeyCredential {
  type: 'api_key';
  key: string;
  headerName?: string;
  headerPrefix?: string;
}

/** Universal union of supported tool credentials */
export type ToolCredential = OAuth2Credential | BearerCredential | ApiKeyCredential;

/**
 * How OAuth requests go out. Every discovery and token request clears the
 * network policy and never follows a redirect.
 */
export interface OAuthTransportOptions {
  /** Network policy for discovery and token requests (default: https to public hosts). */
  network?: NetworkGuardrailSpec;
  /** Resolves each request's host name; one that resolves to a private address is refused. */
  resolveHost?: ResolveHost;
  /** Optional fetch function for testing or proxying */
  fetchFn?: typeof fetch;
}

/** An authorization server's endpoints for one flow, discovered or supplied by the host. */
export interface OAuthEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** The server sends `iss` on authorization responses (RFC 9207); responses without it are refused. */
  issParameterSupported?: boolean;
}

/** Options for creating an OAuth 2.1 PKCE authorization flow */
export interface CreatePkceFlowOptions extends OAuthTransportOptions {
  /**
   * The protected resource the token is for (e.g. the MCP server URL): an https
   * URL, and the token's audience (RFC 8707). A resource without metadata of
   * its own (RFC 9728) is its own authorization server.
   */
  resourceServerUrl: string;
  /** The OAuth client id, or the https URL of its Client ID Metadata Document */
  clientId: string;
  /**
   * Redirect URI registered with the OAuth client, without a fragment: https,
   * http on a loopback host (RFC 8252 §7.3), or a reverse-domain app scheme (§7.1)
   */
  redirectUri: string;
  /** Desired scopes, each a single RFC 6749 §3.3 scope token */
  scopes?: string[];
  /**
   * Secret the stateless state envelope is encrypted under: at least 32 bytes,
   * and 256 bits of entropy (32 CSPRNG bytes, base64-encoded), so a quantum
   * search still faces 128-bit work.
   */
  signingSecret: string;
  /**
   * A value bound to the user's browser session that an attacker can neither know nor
   * set — the host's session id, or a random value in an HttpOnly cookie. The callback
   * must present the same value, so a flow begun in one session can't finish in another
   * (RFC 6749 §10.12). Only its SHA-256 is sealed into the state.
   */
  sessionBinding: string;
  /** State envelope TTL in milliseconds, a positive number (default: 10 minutes) */
  stateTtlMs?: number;
  /** The server's endpoints, when the host already knows them; discovery is skipped */
  preResolved?: OAuthEndpoints;
}

/** Result of initiating a PKCE flow */
export interface PkceFlowResult {
  authorizationUrl: string;
  state: string;
  codeChallenge: string;
  issuer: string;
  resource: string;
}

/** Options for exchanging an authorization code */
export interface ExchangePkceCodeOptions extends OAuthTransportOptions {
  code: string;
  state: string;
  /** `iss` parameter returned in the authorization response query (RFC 9207) */
  iss?: string;
  /** Redirect URI matching the authorization request */
  redirectUri: string;
  /** Secret the state envelope was sealed with */
  signingSecret: string;
  /** The same session binding the flow began with, read from the session handling the callback */
  sessionBinding: string;
}

/** Result of token exchange */
export interface ExchangePkceCodeResult {
  tokens: OAuthTokens;
  credential: OAuth2Credential;
}

/** Options for refreshing an expired OAuth token */
export interface RefreshOAuthTokenOptions extends OAuthTransportOptions {
  refreshToken: string;
  tokenEndpoint: string;
  clientId: string;
  resource: string;
  scope?: string;
  issuer: string;
}
