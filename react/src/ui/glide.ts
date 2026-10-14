import { type RefObject, useLayoutEffect, useRef } from 'react';

/** Reads an Astryx duration token ("410ms" / "0.4s") as milliseconds. */
function tokenMs(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) return fallback;
  return value.trim().endsWith('ms') ? n : n * 1_000;
}

/**
 * Eases an element from where it sat while `held` to where it lands once `held`
 * turns false (FLIP). Astryx has no layout-transition helper, so this uses its
 * `--duration-medium` / `--ease-standard` tokens. `onLand` runs as it lands.
 */
export function useGlide<T extends HTMLElement>(
  held: boolean,
  onLand?: () => void,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const heldTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (held) {
      heldTop.current = el.getBoundingClientRect().top;
      return;
    }
    const from = heldTop.current;
    if (from === null) return;
    heldTop.current = null;
    onLand?.();
    const delta = from - el.getBoundingClientRect().top;
    if (delta === 0 || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const tokens = getComputedStyle(el);
    el.animate([{ transform: `translateY(${String(delta)}px)` }, { transform: 'none' }], {
      duration: tokenMs(tokens.getPropertyValue('--duration-medium'), 410),
      easing: tokens.getPropertyValue('--ease-standard').trim() || 'ease-out',
    });
  });
  return ref;
}
