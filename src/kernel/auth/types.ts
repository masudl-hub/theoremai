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
  resource?: string;
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

/** Options for creating an OAuth 2.1 PKCE authorization flow */
export interface CreatePkceFlowOptions {
  /** Target resource server URL (e.g. MCP server URL) or direct AS URL */
  resourceServerUrl: string;
  /** The OAuth client id or Client ID Metadata Document HTTPS URL */
  clientId: string;
  /** Redirect URI registered with the OAuth client */
  redirectUri: string;
  /** Desired scopes */
  scopes?: string[];
  /** Secret string used to HMAC-sign the stateless state envelope */
  signingSecret: string;
  /** State envelope TTL in milliseconds (default: 10 minutes) */
  stateTtlMs?: number;
  /** Optional pre-resolved discovery metadata to bypass runtime fetch */
  preResolved?: {
    issuer?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    resource?: string;
  };
  /** Optional fetch function for testing or proxying */
  fetchFn?: typeof fetch;
}

/** Result of initiating a PKCE flow */
export interface PkceFlowResult {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  issuer: string;
  resource?: string;
}

/** Options for exchanging an authorization code */
export interface ExchangePkceCodeOptions {
  code: string;
  state: string;
  /** `iss` parameter returned in the authorization response query (RFC 9207) */
  iss?: string;
  /** Redirect URI matching the authorization request */
  redirectUri: string;
  /** Secret used to sign the state envelope */
  signingSecret: string;
  /** Optional token endpoint override (defaults to discovered AS token_endpoint) */
  tokenEndpoint?: string;
  fetchFn?: typeof fetch;
}

/** Result of token exchange */
export interface ExchangePkceCodeResult {
  tokens: OAuthTokens;
  credential: OAuth2Credential;
}

/** Options for refreshing an expired OAuth token */
export interface RefreshOAuthTokenOptions {
  refreshToken: string;
  tokenEndpoint: string;
  clientId: string;
  resource?: string;
  scope?: string;
  issuer: string;
  fetchFn?: typeof fetch;
}
