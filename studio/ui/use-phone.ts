import { DEFAULT_WIDTH_BREAKPOINTS } from '@astryxdesign/core/theme';
import { useCallback, useState, useSyncExternalStore } from 'react';

/** The width below which the studio's text buttons keep only their icon. */
const PHONE = '(width < 768px)';

/** Astryx's desktop width: a row of text buttons narrower than it keeps only their icons. */
const DESKTOP = DEFAULT_WIDTH_BREAKPOINTS.lg;

/** Whether the page is phone-wide. */
export function usePhone() {
  return useSyncExternalStore(
    (change) => {
      const query = globalThis.matchMedia(PHONE);
      query.addEventListener('change', change);
      return () => {
        query.removeEventListener('change', change);
      };
    },
    () => globalThis.matchMedia(PHONE).matches,
    () => false,
  );
}

/**
 * Whether the element `ref` is set on is narrower than the desktop width. It measures the row, not
 * the window, so a pane beside the editor collapses as a narrow window does.
 */
export function useBelowDesktop() {
  const [below, setBelow] = useState(false);
  const ref = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setBelow((entry?.contentRect.width ?? DESKTOP) < DESKTOP);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { ref, below };
}
