/**
 * Direct entry for local OpenAI-compatible servers, bypassing `createProvider`.
 * Importing it loads the local adapter eagerly.
 *
 * @module
 */

export { createLocalProvider } from './local.ts';
