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
	return trigger.closest('[role="treeitem"]')?.querySelector<HTMLElement>(':scope > [role="group"]') ?? null;
}

function ownsMotion(panel: HTMLElement): boolean {
	return getComputedStyle(panel).transitionDuration.split(',').some((d) => Number.parseFloat(d) > 0);
}

function isToggleKey(event: Event): boolean {
	return !(event instanceof KeyboardEvent) || event.key === 'Enter' || event.key === ' ';
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
			// A shut panel stays shut until its unmount; an open one hands back to its natural height.
			fill: direction === 'close' ? 'forwards' : 'none',
		},
	);
}

/** Every animation on a panel, settled; a cancelled one rejects `finished`, so settle rather than await all. */
function settled(panel: HTMLElement): Promise<unknown> {
	return Promise.allSettled(panel.getAnimations().map((animation) => animation.finished));
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
		// The trigger the reader just pressed to open; opens the page makes itself aren't eased or followed.
		let opening: Element | undefined;

		// Capture, before the component toggles: note what the trigger was, and hold a close.
		const before = (event: Event) => {
			if (!isToggleKey(event) || replaying.has(event)) return;
			const trigger = event.target instanceof Element ? event.target.closest('[aria-expanded]') : null;
			if (!trigger || !root.contains(trigger)) return;
			if (closing.has(trigger)) {
				event.stopPropagation();
				event.preventDefault();
				return;
			}
			if (trigger.getAttribute('aria-expanded') !== 'true') {
				// The toggle commits within this event; a stale note must not claim a later change.
				const noted = trigger;
				opening = noted;
				setTimeout(() => {
					if (opening === noted) opening = undefined;
				});
				return;
			}
			const panel = panelOf(trigger);
			if (!panel || still.matches || ownsMotion(panel)) return;
			event.stopPropagation();
			event.preventDefault();
			closing.add(trigger);
			const target = event.target as Element;
			const replay =
				event instanceof KeyboardEvent
					? new KeyboardEvent(event.type, { key: event.key, bubbles: true, cancelable: true })
					: new MouseEvent(event.type, { bubbles: true, cancelable: true });
			void ease(panel, 'close').finished.then(() => {
				closing.delete(trigger);
				replaying.add(replay);
				target.dispatchEvent(replay);
			});
		};

		// After the component commits the toggle (a component may stop the event, so
		// watch the attribute rather than wait for the event to bubble): ease the new panel.
		const opened = new MutationObserver(() => {
			const trigger = opening;
			if (!trigger || trigger.getAttribute('aria-expanded') !== 'true') return;
			opening = undefined;
			const panel = panelOf(trigger);
			if (!panel) return;
			if (!still.matches && !ownsMotion(panel)) ease(panel, 'open');
			onOpened?.(trigger, panel, settled(panel));
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
