/**
 * The studio screen's server, for a host that shows the screen: `createStudioDraftHandler`
 * answers every request the screen makes under `/api/studio`.
 *
 * @module
 */
export {
  createStudioDraftHandler,
  type LentRuntime,
  type ProbeEntry,
  STUDIO_BASE,
  type StudioDraftHandler,
  type StudioDraftHandlerOptions,
  type StudioSpend,
} from './server/draft-handler.ts';
export { decisionRequestSchema } from './server/draft-decide.ts';
