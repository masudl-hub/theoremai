import { useSyncExternalStore } from 'react';

/** The width below which the studio's text buttons keep only their icon. */
const PHONE = '(width < 768px)';

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
