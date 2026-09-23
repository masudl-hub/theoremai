/**
 * Playground fixtures and helpers — demo graph seeds and function handlers.
 *
 * @module
 */

export {
  DEMO_ALLOWED_HOSTS,
  DEMO_CONCIERGE_SYSTEM,
  DEMO_HTTP_SAMPLE_INPUT,
  demoHttpSampleInput,
  demoInputsSpec,
  demoToolSpecs,
} from './concierge-demo.ts';
export type { PlaygroundDemoHandler } from './demo-handlers.ts';
export { playgroundDemoHandler } from './demo-handlers.ts';
export { stubOutputFromSchema } from './stub.ts';
export type {
  PlaygroundInputsSpec,
  PlaygroundToolSeed,
  PlaygroundToolSpecSeed,
} from './types.ts';
export { registerPlaygroundLiveProfile } from './live-register.ts';
export type {
  FunctionToolRegistration,
  HttpToolRegistration,
  McpToolRegistration,
  StructuredRegistration,
  ToolRegistration,
} from './registrations.ts';
export {
  clearPlaygroundRunPayload,
  createPlaygroundRunId,
  loadPlaygroundRunPayload,
  PLAYGROUND_RUN_INDEX_KEY,
  PLAYGROUND_RUN_PAYLOAD_CAP,
  PLAYGROUND_RUN_PAYLOAD_KEY,
  PLAYGROUND_RUN_PAYLOAD_KEY_PREFIX,
  type PlaygroundRunIndex,
  type PlaygroundRunIndexEntry,
  type PlaygroundRunPayload,
  playgroundRunPayloadKey,
  readPlaygroundRunIdFromUrl,
  savePlaygroundRunPayload,
  upsertPlaygroundRunIndex,
} from './run-payload.ts';
export { createPlaygroundTransport, playgroundInterface } from './transport.ts';
