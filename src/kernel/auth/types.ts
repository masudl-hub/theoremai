import type { ResolveHost } from '../../guardrails/network.ts';
import type { NetworkGuardrailSpec } from '../../guardrails/types.ts';

/** RFC 9728. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_documentation?: string;
  [key: string]: unknown;
}

/** RFC 8414 / OpenID Connect Discovery. */
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

export interface OAuthTokens {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  [key: string]: unknown;
}

export interface OAuth2Credential {
  type: 'oauth2';
  issuer: string;
  /** RFC 8707: the token is sent nowhere else. */
  resource: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number; // epoch ms
  tokenEndpoint: string;
  clientId: string;
  scope?: string;
}

export interface BearerCredential {
  type: 'bearer';
  token: string;
}

export interface ApiKeyCredential {
  type: 'api_key';
  key: string;
  headerName?: string;
  headerPrefix?: string;
}

export type ToolCredential = OAuth2Credential | BearerCredential | ApiKeyCredential;

/** Every discovery and token request clears the network policy and never follows a redirect. */
export interface OAuthTransportOptions {
  /** Default: https to public hosts. */
  network?: NetworkGuardrailSpec;
  /** A host that resolves to a private address is refused. */
  resolveHost?: ResolveHost;
  fetchFn?: typeof fetch;
}

export interface OAuthEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** RFC 9207: authorization responses without `iss` are then refused. */
  issParameterSupported?: boolean;
}

export interface CreatePkceFlowOptions extends OAuthTransportOptions {
  /**
   * An https URL (e.g. the MCP server) and the token's audience (RFC 8707). Without
   * RFC 9728 metadata of its own it is its own authorization server.
   */
  resourceServerUrl: string;
  /** Or the https URL of its Client ID Metadata Document. */
  clientId: string;
  /** No fragment: https, http on loopback (RFC 8252 §7.3), or a reverse-domain app scheme (§7.1). */
  redirectUri: string;
  /** Each a single RFC 6749 §3.3 scope token. */
  scopes?: string[];
  /**
   * Encrypts the state envelope: at least 32 bytes and 256 bits of entropy (32 CSPRNG bytes,
   * base64-encoded), so a quantum search still faces 128-bit work.
   */
  signingSecret: string;
  /**
   * Bound to the user's session and neither knowable nor settable by an attacker (a session id,
   * an HttpOnly cookie value). The callback must present it (RFC 6749 §10.12); only its SHA-256 is sealed.
   */
  sessionBinding: string;
  /** Milliseconds; default 10 minutes. */
  stateTtlMs?: number;
  /** Skips discovery. */
  preResolved?: OAuthEndpoints;
}

export interface PkceFlowResult {
  authorizationUrl: string;
  state: string;
  codeChallenge: string;
  issuer: string;
  resource: string;
}

export interface ExchangePkceCodeOptions extends OAuthTransportOptions {
  code: string;
  state: string;
  /** From the authorization response query (RFC 9207). */
  iss?: string;
  /** Must match the authorization request. */
  redirectUri: string;
  signingSecret: string;
  /** Read from the session handling the callback. */
  sessionBinding: string;
}

export interface ExchangePkceCodeResult {
  tokens: OAuthTokens;
  credential: OAuth2Credential;
}

export interface RefreshOAuthTokenOptions extends OAuthTransportOptions {
  refreshToken: string;
  tokenEndpoint: string;
  clientId: string;
  resource: string;
  scope?: string;
  issuer: string;
}
