/**
 * The panel takes the whole frame for the map or Settings, and gives it back. What is on screen
 * and will not stay eases out, the panel's far edge moves if its width changes, and what comes in
 * eases in. The shell's rail is outside the panel and never moves.
 */
import { HOLD_MS, prefersReducedMotion, sleep } from '../shell-motion.ts';

const MOVE_MS = 640;
const FADE_MS = 280;
const EASE = 'cubic-bezier(0.45, 0.02, 0.15, 1)';

/** What the panel shows: the map beside the editor, Settings in place of both, or neither. */
export interface PanelView {
  map: boolean;
  settings: boolean;
}

const PARTS = {
  tree: '.studio-tree',
  editor: '.studio-view',
  handle: '.studio-side-handle',
  preview: '.studio-preview',
  map: '.studio-map-pane, .studio-map-handle',
  settings: '.studio-settings',
} as const;

type Part = keyof typeof PARTS;

function shown(view: PanelView): Part[] {
  if (view.settings) return ['settings'];
  if (view.map) return ['tree', 'editor', 'map'];
  return ['tree', 'editor', 'handle', 'preview'];
}

const isWide = (view: PanelView) => view.map || view.settings;

/** A phone's panel already takes the frame, and reduced motion moves nothing. */
export function panelCanMove(): boolean {
  return globalThis.matchMedia('(min-width: 768px)').matches && !prefersReducedMotion();
}

/** A tab in the background runs no animation, so each one is also given its time and no longer. */
function ended(animations: Animation[], ms: number): Promise<unknown> {
  const all = Promise.all(animations.map((each) => each.finished.catch(() => undefined)));
  return Promise.race([all, sleep(ms + 200)]);
}

/**
 * Move the panel from `from` to `to` around `swap`, which puts `to` on screen and must have drawn
 * it by the time it returns. Without a panel to move, the swap happens at once.
 */
export async function movePanel(from: PanelView, to: PanelView, swap: () => void): Promise<void> {
  const frame = document.querySelector<HTMLElement>('.studio-frame');
  const surface = frame?.querySelector<HTMLElement>('[data-shell-frame]');
  if (!frame || !surface || !panelCanMove()) {
    swap();
    return;
  }
  const find = (parts: Part[]) =>
    parts.flatMap((part) => [...frame.querySelectorAll<HTMLElement>(PARTS[part])]);
  const before = shown(from);
  const after = shown(to);
  const leaving = find(before.filter((part) => !after.includes(part)));
  const coming = after.filter((part) => !before.includes(part));
  const held: Animation[] = [];
  const hold = (els: HTMLElement[]) => {
    for (const each of els) {
      held.push(each.animate({ opacity: [0, 0] }, { duration: MOVE_MS, fill: 'forwards' }));
    }
  };

  const out = leaving.map((each) =>
    each.animate({ opacity: [1, 0] }, { duration: HOLD_MS, easing: 'ease', fill: 'forwards' }),
  );
  await ended(out, HOLD_MS);

  // The panel is drawn at its full width, cut back to the width it rests at: only the cut moves.
  // The corners are the raised surface's own, which the frame wraps.
  const drawn = surface.firstElementChild ?? surface;
  const round = getComputedStyle(drawn).borderTopRightRadius || '0px';
  const cut = (width: number) => `inset(0 calc(100% - ${String(width)}px) 0 0 round ${round})`;
  const whole = `inset(0 0 0 0 round ${round})`;
  const swapHidden = () => {
    swap();
    // invariant: what comes in is held out of sight in the same task as the swap, before a paint.
    hold(find(coming));
  };
  let move: Animation | undefined;
  if (isWide(to) && !isWide(from)) {
    const narrow = surface.offsetWidth;
    surface.dataset.rests = String(narrow);
    move = surface.animate(
      { clipPath: [cut(narrow), whole] },
      { duration: MOVE_MS, easing: EASE, fill: 'both' },
    );
    swapHidden();
    await ended([move], MOVE_MS);
  } else if (!isWide(to) && isWide(from)) {
    const narrow = Number(surface.dataset.rests);
    delete surface.dataset.rests;
    if (narrow > 0) {
      move = surface.animate(
        { clipPath: [whole, cut(narrow)] },
        { duration: MOVE_MS, easing: EASE, fill: 'both' },
      );
      await ended([move], MOVE_MS);
    }
    swapHidden();
  } else {
    swapHidden();
  }

  const fades = find(coming).map((each) =>
    each.animate({ opacity: [0, 1] }, { duration: FADE_MS, easing: EASE, fill: 'backwards' }),
  );
  for (const each of held) each.cancel();
  move?.cancel();
  await ended(fades, FADE_MS);
  for (const each of out) each.cancel();
}
