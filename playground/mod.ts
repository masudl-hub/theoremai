/**
 * Playground fixtures and helpers — the editable draft, its tree, the compiler
 * that turns it into a profile, source export, demo seeds, and run handoff.
 *
 * @module
 */

export {
  type CompiledPlayground,
  compilePlayground,
  type PlaygroundCompileResult,
  type PlaygroundIssue,
  type PlaygroundProfileDefinition,
} from './compile.ts';
export {
  createBlankDraft,
  defaultModelBinding,
  defaultToolSpec,
  draftAllows,
  draftFacets,
  draftKey,
  type EffortDraft,
  excludeFacet,
  type GuardrailsDraft,
  type IdentityDraft,
  type ImageDraft,
  includableFacets,
  includeFacet,
  type InputsDraft,
  type LiveDraft,
  type ModelBindingDraft,
  type ModelsDraft,
  newModelBinding,
  newToolSpec,
  type ObservabilityDraft,
  type OutputsDraft,
  PLAYGROUND_PROFILE_TYPES,
  type PlaygroundDraft,
  type PlaygroundProfileType,
  setProfileType,
  type SpeechDraft,
  takesContinueInstruction,
  type ToolsDraft,
  type ToolSpecDraft,
  type TurnBehaviourDraft,
} from './draft.ts';
export { createExampleDraft } from './example.ts';
export {
  type AcceptSection,
  acceptSections,
  expandAccept,
  nextAccept,
} from './media-accept.ts';
export {
  allowedBuiltinsForGemini,
  defaultBindingForProfileType,
  GEMINI_PLAYGROUND_DEFAULT_API_ID,
  GEMINI_PLAYGROUND_IMAGE_DEFAULT_API_ID,
  GEMINI_PLAYGROUND_LIVE_DEFAULT_API_ID,
  GEMINI_PLAYGROUND_LIVE_INPUT_TOKENS,
  GEMINI_PLAYGROUND_MODELS,
  GEMINI_PLAYGROUND_TTS_DEFAULT_API_ID,
  type GeminiPlaygroundModel,
  geminiPlaygroundModel,
  isGoogleTransport,
  isOpenRouterTransport,
  isProviderBuiltinId,
  type ModelBindingViolation,
  modelBindingViolation,
  OPENROUTER_PLAYGROUND_API_ID,
  PLAYGROUND_TRACE_DESTINATION,
  playgroundRunsTransport,
  servesOtherProfileType,
} from './policy.ts';
export {
  defaultEffortRequired,
  defaultModelRequired,
  inputLimitsRequired,
  keySlotRequired,
} from './requirements.ts';
export { playgroundSource } from './source.ts';
export {
  createPlaygroundTraceRouter,
  PLAYGROUND_RUN_METADATA_KEY,
  type PlaygroundTraceLine,
  type PlaygroundTraceRoute,
  type PlaygroundTraceRouter,
} from './traces.ts';
export {
  DEFAULT_TOOL_INPUT_SCHEMA,
  DEFAULT_TOOL_OUTPUT_SCHEMA,
  parseJsonSchema,
  sampleFromJsonSchema,
  zodExprFromJsonSchema,
  zodFromJsonSchema,
} from './tool-schema.ts';
export {
  modelBindingNodeId,
  type PlaygroundNodeRef,
  playgroundNodeRef,
  playgroundTree,
  type PlaygroundTreeNode,
  toolSpecNodeId,
} from './tree.ts';

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
export { sampleToolInput, stubOutputFromSchema } from './stub.ts';
export type { PlaygroundInputsSpec, PlaygroundToolSeed, PlaygroundToolSpecSeed } from './types.ts';
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
