/**
 * @module
 * The ready-made decider for an app with no server of its own: the page open on the chat wakes it.
 */
import type { LateResultsDecider } from '@theoremjs/agents';

/** Replies that may read one result: the first, and one more after a reply that failed or lost the chat. */
const READS_PER_RESULT_COUNT = 2;

/**
 * Each late result is told to the first reply that runs, and the page open on the chat wakes it
 * when one waits. A result two replies read without telling is given up, and reported once as
 * `late_results_given_up`, so a model that keeps failing does not reply again and again.
 */
export const tellEveryResult: LateResultsDecider = {
  policy: (items) => ({
    tell: items
      .filter((item) => item.handovers.length < READS_PER_RESULT_COUNT)
      .map((item) => item.id),
    giveUp: items
      .filter((item) => item.handovers.length >= READS_PER_RESULT_COUNT)
      .map((item) => item.id),
  }),
};
