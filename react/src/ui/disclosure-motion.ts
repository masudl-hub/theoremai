import { type RefObject, useEffect } from 'react';

/**
 * Easing for disclosures whose panel mounts on open and unmounts on close
 * (ChatToolCalls row details, TreeList branches): CSS can't ease an element
 * that's already gone, so a close is held until the panel has eased shut,
 * then replayed; an open eases the new panel up from nothing. Panels that
 * carry their own transition (the themed Collapsible) are left alone.
 */

/** The panel a disclosure trigger shows: its aria-controls target, or a tree item's group. */
function panelOf(trigger: Element): HTMLElement | null {
  const id = trigger.getAttribute('aria-controls');
  if (id) return document.getElementById(id);
  return (
    trigger.closest('[role="treeitem"]')?.querySelector<HTMLElement>(':scope > [role="group"]') ??
    null
  );
}

function ownsMotion(panel: HTMLElement): boolean {
  return getComputedStyle(panel)
    .transitionDuration.split(',')
    .some((d) => Number.parseFloat(d) > 0);
}

function isToggleKey(event: Event): boolean {
  return !(event instanceof KeyboardEvent) || event.key === 'Enter' || event.key === ' ';
}

/**
 * The element pressed and the disclosure trigger it sits in, when that trigger is under `root`. In a
 * tree, the press is the row's own: a leaf's row toggles nothing, and a row with an action of its own
 * (a label that selects it, a button at its end) toggles only at its chevron.
 */
function pressedToggle(
  event: Event,
  root: Element,
): { target: Element; trigger: Element } | undefined {
  if (!(event.target instanceof Element)) return undefined;
  const row = event.target.closest('[role="treeitem"]');
  const trigger = row ? treeToggle(event.target, row) : event.target.closest('[aria-expanded]');
  if (!trigger || !root.contains(trigger)) return undefined;
  return { target: event.target, trigger };
}

/** The tree row a press toggles: none for a leaf, and for a row with an action of its own, only a press at its chevron. */
function treeToggle(target: Element, row: Element): Element | undefined {
  if (!row.hasAttribute('aria-expanded')) return undefined;
  if (target.closest('[data-tree-toggle]') !== null) return row;
  const acts =
    row.querySelector(':scope > div :is(button:not([data-tree-toggle]), a[href])') !== null;
  return acts ? undefined : row;
}

/** Stops the event: the component does not see it. */
function hold(event: Event): void {
  event.stopPropagation();
  event.preventDefault();
}

/** A copy of the pressed key or click, to send once the panel has eased shut. */
function replayOf(event: Event): Event {
  return event instanceof KeyboardEvent
    ? new KeyboardEvent(event.type, { key: event.key, bubbles: true, cancelable: true })
    : new MouseEvent(event.type, { bubbles: true, cancelable: true });
}

/** CSS time (`0.3s`, `300ms`) in milliseconds. */
function ms(time: string): number {
  const value = Number.parseFloat(time);
  return time.trim().endsWith('ms') ? value : value * 1000;
}

/** Eases a panel's height between shut and its natural height, the theme's medium duration and standard curve. */
function ease(panel: HTMLElement, direction: 'open' | 'close'): Animation {
  const style = getComputedStyle(panel);
  const open = {
    height: `${String(panel.getBoundingClientRect().height)}px`,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
  };
  const shut = { height: '0px', paddingTop: '0px', paddingBottom: '0px' };
  const frames = direction === 'open' ? [shut, open] : [open, shut];
  for (const animation of panel.getAnimations()) animation.cancel();
  return panel.animate(
    frames.map((frame) => ({ ...frame, boxSizing: 'border-box', overflow: 'clip' })),
    {
      duration: ms(style.getPropertyValue('--duration-medium')),
      easing: style.getPropertyValue('--ease-standard').trim(),
      // why: A shut panel stays shut until its unmount; an open one hands back to its natural height.
      fill: direction === 'close' ? 'forwards' : 'none',
    },
  );
}

/** Every animation on a panel, settled; a cancelled one rejects `finished`, so settle rather than await all. */
function settled(panel: HTMLElement): Promise<unknown> {
  return Promise.allSettled(panel.getAnimations().map((animation) => animation.finished));
}

/** The attribute Astryx's chat sets on its scroller while it follows new content to the bottom. */
const FOLLOWING = 'data-astryx-chat-following';

/** How far from its bottom a scroll up must land for Astryx's chat to stop following: past its 10px lock threshold. */
const LET_GO = 11;

/**
 * Keeps a trigger the reader opened where it was while its panel grows. A
 * chat that follows its bottom would spring past it, so the follow is let go
 * first: a scroll up just past the chat's threshold reads as the reader's.
 * The panel's growth then gives the room back, and the trigger ends where it
 * was. A chat too short to scroll yet is held after each layout instead,
 * after the follow's own frame, which also lets it go.
 */
function holdInPlace(trigger: Element, panel: HTMLElement, motion: Promise<unknown>): void {
  const scroller = trigger.closest<HTMLElement>(`[${FOLLOWING}]`);
  if (!scroller) return;
  const top = trigger.getBoundingClientRect().top;
  const room = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  scroller.scrollTop -= Math.max(0, LET_GO - room());
  let done = false;
  void motion.then(() => setTimeout(() => (done = true), 1000));
  const held = new ResizeObserver(() => {
    const drift = trigger.getBoundingClientRect().top - top;
    if (drift && scroller.hasAttribute(FOLLOWING)) scroller.scrollTop += drift;
  });
  held.observe(panel);
  const giveBack = () => {
    const drift = trigger.getBoundingClientRect().top - top;
    // invariant: Never back within the threshold, or the chat would follow again.
    if (drift > 0 && !scroller.hasAttribute(FOLLOWING)) {
      scroller.scrollTop += Math.max(0, Math.min(drift, room() - LET_GO));
    }
    if (done || (drift <= 0.5 && !scroller.hasAttribute(FOLLOWING))) held.disconnect();
    else requestAnimationFrame(giveBack);
  };
  requestAnimationFrame(giveBack);
}

/**
 * Eases every disclosure under `ref` open and shut. `onOpened` runs once the
 * new panel is in the DOM, with a promise for its motion finishing.
 */
export function useDisclosureMotion(
  ref: RefObject<HTMLElement | null>,
  onOpened?: (trigger: Element, panel: HTMLElement, motion: Promise<unknown>) => void,
): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    const closing = new WeakSet<Element>();
    const replaying = new WeakSet<Event>();
    // why: The trigger the reader just pressed to open; opens the page makes itself aren't eased or followed.
    let opening: Element | undefined;

    /** The trigger the reader pressed opens: note it until the toggle commits, within this event. */
    const noteOpening = (trigger: Element) => {
      opening = trigger;
      // why: A stale note must not claim a later change.
      setTimeout(() => {
        if (opening === trigger) opening = undefined;
      });
    };

    /** The panel a close should ease shut first; none when motion is off or the panel eases itself. */
    const panelToEase = (trigger: Element): HTMLElement | undefined => {
      const panel = panelOf(trigger);
      return panel && !still.matches && !ownsMotion(panel) ? panel : undefined;
    };

    const before = (event: Event) => {
      if (!isToggleKey(event) || replaying.has(event)) return;
      const pressed = pressedToggle(event, root);
      if (!pressed) return;
      const { target, trigger } = pressed;
      if (closing.has(trigger)) {
        hold(event);
        return;
      }
      if (trigger.getAttribute('aria-expanded') !== 'true') {
        noteOpening(trigger);
        return;
      }
      const panel = panelToEase(trigger);
      if (!panel) return;
      hold(event);
      closing.add(trigger);
      const replay = replayOf(event);
      void ease(panel, 'close').finished.then(() => {
        closing.delete(trigger);
        replaying.add(replay);
        target.dispatchEvent(replay);
      });
    };

    // why: After the component commits the toggle (a component may stop the event, so
    // watch the attribute rather than wait for the event to bubble): ease the new panel.
    const opened = new MutationObserver(() => {
      const trigger = opening;
      if (trigger?.getAttribute('aria-expanded') !== 'true') return;
      opening = undefined;
      const panel = panelOf(trigger);
      if (!panel) return;
      if (!still.matches && !ownsMotion(panel)) ease(panel, 'open');
      const motion = settled(panel);
      holdInPlace(trigger, panel, motion);
      onOpened?.(trigger, panel, motion);
    });
    opened.observe(root, { subtree: true, attributeFilter: ['aria-expanded'] });

    root.addEventListener('click', before, true);
    root.addEventListener('keydown', before, true);
    return () => {
      opened.disconnect();
      root.removeEventListener('click', before, true);
      root.removeEventListener('keydown', before, true);
    };
  }, [ref, onOpened]);
}
