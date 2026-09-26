/**
 * Direct entry for local OpenAI-compat providers (Ollama, vLLM, etc.).
 * Importing this module loads the local adapter graph — prefer `createProvider`
 * when routing from a profile unless you intentionally bypass the factory.
 *
 * @module
 */

export { createLocalProvider } from './local.ts';
