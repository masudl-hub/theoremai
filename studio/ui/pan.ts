/**
 * A field that pans: dragged with a mouse or a pen, scrolled with a finger or a wheel. The map and
 * the site's showcase pan alike.
 */
import { type PointerEvent as ReactPointerEvent, useState } from 'react';

/** The box around `from` that scrolls, if one does. */
export function scrollerOf(from: HTMLElement): HTMLElement | undefined {
  for (let each = from.parentElement; each; each = each.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(each);
    if (/auto|scroll/.test(`${overflowX} ${overflowY}`)) return each;
  }
  return undefined;
}

/** Where `field` starts inside `scroller`'s scrolled content. */
export function fieldStart(
  field: HTMLElement,
  scroller: HTMLElement,
): { left: number; top: number } {
  const box = field.getBoundingClientRect();
  const port = scroller.getBoundingClientRect();
  return {
    left: box.left - port.left + scroller.scrollLeft,
    top: box.top - port.top + scroller.scrollTop,
  };
}

const clamp = (value: number, most: number) => Math.min(Math.max(value, 0), Math.max(most, 0));

/**
 * Scroll the box around `field` to `at`, once it can: a field that is still opening has no box that
 * scrolls yet, so it tries again each frame until the scroll lands. Returns what stops the tries.
 */
export function scrollOnce(
  field: HTMLElement,
  at: (scroller: HTMLElement) => { left: number; top: number },
): () => void {
  let frame = 0;
  let tries = 120;
  const go = () => {
    tries -= 1;
    const scroller = scrollerOf(field);
    if (scroller && scroller.scrollWidth > scroller.clientWidth) {
      const wanted = at(scroller);
      // A place past either end lands at that end.
      const left = clamp(wanted.left, scroller.scrollWidth - scroller.clientWidth);
      const top = clamp(wanted.top, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTo({ left, top, behavior: 'instant' });
      if (Math.abs(scroller.scrollLeft - left) < 1 && Math.abs(scroller.scrollTop - top) < 1)
        return;
    }
    if (tries > 0) frame = requestAnimationFrame(go);
  };
  go();
  return () => {
    cancelAnimationFrame(frame);
  };
}

/** A mouse or a pen drags; a finger scrolls the field as it always does. */
export const drags = (event: ReactPointerEvent) =>
  event.button === 0 && event.pointerType !== 'touch';

/**
 * Follow the pointer that pressed until it lifts, wherever it goes: `onMove` with how far it is
 * from where it pressed, then `onEnd`, with whether it lifted or the press was called off.
 */
export function follow(
  press: ReactPointerEvent,
  onMove: (x: number, y: number) => void,
  onEnd: (lifted: boolean) => void,
): void {
  const { pointerId, clientX, clientY } = press;
  const move = (event: PointerEvent) => {
    if (event.pointerId === pointerId) onMove(event.clientX - clientX, event.clientY - clientY);
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    globalThis.removeEventListener('pointermove', move);
    globalThis.removeEventListener('pointerup', end);
    globalThis.removeEventListener('pointercancel', end);
    onEnd(event.type === 'pointerup');
  };
  globalThis.addEventListener('pointermove', move);
  globalThis.addEventListener('pointerup', end);
  globalThis.addEventListener('pointercancel', end);
}

/** A drag that starts on the field, off anything `held` matches, pans it. */
export function usePan(held: string) {
  const [panning, setPanning] = useState(false);
  const pan = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drags(event) || (event.target as Element).closest(held)) return;
    const scroller = scrollerOf(event.currentTarget);
    if (!scroller) return;
    const { scrollLeft, scrollTop } = scroller;
    setPanning(true);
    follow(
      event,
      (x, y) => {
        scroller.scrollTo({ left: scrollLeft - x, top: scrollTop - y, behavior: 'instant' });
      },
      () => {
        setPanning(false);
      },
    );
  };
  return { panning, pan };
}
