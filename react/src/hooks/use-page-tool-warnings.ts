import { type PageTools, warnPageToolMismatch } from '@theoremjs/web/client';
import { useEffect } from 'react';

/** Says in the console, once for each set of names, where the page's tools and the profile's disagree. */
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
    warnPageToolMismatch(named ? named.split('\n') : [], handled ? handled.split('\n') : []);
  }, [named, handled]);
}
