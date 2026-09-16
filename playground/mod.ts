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
