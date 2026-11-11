/**
 * @module
 * The ready-made decider for an app with no server of its own: the page open on the chat wakes it.
 */
import type { LateResultsDecider } from '@theoremjs/agents';

/**
 * The page open on a chat wakes it when a background call ends, and a reply reads every result
 * that waits. It keeps no count: each result is read once, by the first reply that runs.
 */
export const pageWakes: LateResultsDecider = {
  give: ({ results }) => results.map((result) => result.operationId),
  due: ({ results }) => results.length > 0,
};
