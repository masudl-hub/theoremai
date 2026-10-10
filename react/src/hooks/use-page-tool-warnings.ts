import { useEffect } from 'react';
import { type PageTools, pageToolMismatch } from '../client/live/live-page-tool.ts';

/**
 * Says in the console, once, where the page's tools and the profile's disagree. A wrong name is
 * the builder's to fix, so it is never said to the visitor.
 */
export function usePageToolWarnings(
  declared: readonly string[] | undefined,
  pageTools: PageTools | undefined,
): void {
  const handled = Object.keys(pageTools ?? {})
    .sort()
    .join('\n');
  const named = declared?.join('\n');
  useEffect(() => {
    if (named === undefined) return;
    const { unanswered, unused } = pageToolMismatch(
      named ? named.split('\n') : [],
      handled ? handled.split('\n') : [],
    );
    for (const name of unanswered) {
      // lexicon-exempt: builder diagnostic
      console.warn(
        `Theorem: page tool '${name}' has no handler in pageTools; the agent gets no answer.`,
      );
    }
    for (const name of unused) {
      // lexicon-exempt: builder diagnostic
      console.warn(
        `Theorem: pageTools has '${name}', which the profile does not declare answeredBy: 'page'.`,
      );
    }
  }, [named, handled]);
}
