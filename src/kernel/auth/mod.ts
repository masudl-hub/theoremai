/**
 * Authentication and authorization primitives for Theorem.
 *
 * Implements stateless OAuth 2.1 PKCE, RFC 9728 discovery, RFC 8414 AS metadata,
 * RFC 9207 issuer validation, and RFC 8707 resource indicators.
 *
 * @module
 */

export * from './crypto.ts';
export * from './oauth.ts';
export * from './types.ts';
