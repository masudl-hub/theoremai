import { useEffect, useState } from 'react';

/** `Date.now()`, refreshed every second while `active`. */
export function useSecondTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, [active]);
  return now;
}
