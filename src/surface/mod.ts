/**
 * Surfaces: one protocol for an agent to see and work in a client's screen. A page mounts a
 * surface (nodes with fields and actions); the agent uses two tools, `look` and `act`, and the
 * runtime projects every answer so secrets reach it only as cards.
 */

export type { SecretCard } from './formats.ts';
export { knownSecrets, maskHeaders, maskUrl, scrubDeep, scrubText, secretCard } from './formats.ts';
export type {
  SurfaceLedgerEntry,
  SurfaceRuntime,
  SurfaceRuntimeOptions,
} from './runtime.ts';
export { createSurfaceRuntime, SURFACE_TOOL_NAMES } from './runtime.ts';
export type { SurfaceToolsOptions } from './tools.ts';
export { clientAnsweredHandler, SURFACE_PROMPT, surfaceTools } from './tools.ts';
export type {
  Surface,
  SurfaceAction,
  SurfaceActionContext,
  SurfaceActionOutcome,
  SurfaceAuthor,
  SurfaceChange,
  SurfaceEffect,
  SurfaceField,
  SurfaceFieldFormat,
  SurfaceIssue,
  SurfaceNode,
  SurfaceRejection,
} from './types.ts';
export { defineAction } from './types.ts';
