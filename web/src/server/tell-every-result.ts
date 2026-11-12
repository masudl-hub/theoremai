/**
 * @module
 * The ready-made decider for an app with no server of its own: the page open on the chat wakes it.
 */
import type { LateResultsDecider } from '@theoremjs/agents';

/**
 * Each late result is told to the first reply that runs, and the page open on the chat wakes it
 * when one waits. It keeps no count, and gives up nothing.
 */
export const tellEveryResult: LateResultsDecider = {
  policy: (items) => ({ tell: items.map((item) => item.id) }),
};
