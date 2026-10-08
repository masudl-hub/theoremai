/**
 * Low-level codec entry for local OpenAI-compatible servers. Registered runners use `openAIChat`.
 * Importing it loads the local adapter eagerly.
 *
 * @module
 */

export { createLocalProvider } from './local.ts';
