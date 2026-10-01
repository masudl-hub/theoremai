import type { StreamView } from '../../react/src/client/run-commit.ts';

/** A run's view for a test whose stream skips nothing: blocks go nowhere, and a skipped line fails the test. */
export const unskippedView: StreamView = {
  blocks: () => {},
  skipped: (error) => {
    throw error;
  },
};
