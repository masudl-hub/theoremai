import { VStack } from '@astryxdesign/core/VStack';
import { Children, isValidElement, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { columnCount, wallPlaces } from './wall-columns.ts';

type Wall = { width: number; gap: number; heights: readonly (number | undefined)[] };

function sameWall(a: Wall, b: Wall): boolean {
  return (
    a.width === b.width &&
    a.gap === b.gap &&
    a.heights.length === b.heights.length &&
    a.heights.every((height, at) => height === b.heights[at])
  );
}

/**
 * Cards in as many columns as fit, each as tall as its content. Each card,
 * in order, goes under the shortest column so far, so short cards never
 * leave a hole beside a tall one. A card that renders nothing takes no place.
 *
 * invariant: Cards stay in one container in source order and are only moved,
 * so a reflow never remounts a card and focus and tab order follow the source.
 */
export function CardWall({ minWidth, children }: { minWidth: number; children: ReactNode }) {
  const cards = Children.toArray(children);
  const keyOf = (card: (typeof cards)[number], at: number) =>
    isValidElement(card) && card.key !== null ? card.key : String(at);
  const wallRef = useRef<HTMLDivElement>(null);
  const slots = useRef<(HTMLDivElement | null)[]>([]);
  const observer = useRef<ResizeObserver | null>(null);
  const slotRefs = useRef<((slot: HTMLDivElement | null) => () => void)[]>([]);
  // why: One callback per place, so a re-render does not detach and watch every slot again.
  const slotRef = (at: number) => {
    slotRefs.current[at] ??= (slot) => {
      slots.current[at] = slot;
      // why: A card that mounts later is measured once it is watched.
      if (slot) observer.current?.observe(slot);
      return () => {
        if (slot) observer.current?.unobserve(slot);
      };
    };
    return slotRefs.current[at];
  };
  const [wall, setWall] = useState<Wall>({ width: 0, gap: 0, heights: [] });
  const count = columnCount(wall.width, minWidth, wall.gap);
  const columnWidth = (wall.width - wall.gap * (count - 1)) / count;
  const { places, height } = wallPlaces(
    cards.map((_, at) => wall.heights[at]),
    count,
    wall.gap,
  );
  // why: Until the wall is measured, cards stack in flow so the first paint has their heights.
  const isPlaced = wall.width > 0;
  slots.current.length = cards.length;

  useLayoutEffect(() => {
    const node = wallRef.current;
    if (!node) return;
    const sizes = new WeakMap<Element, number>();
    let width = 0;
    // why: Sizes come only from the observer, after the browser's own layout: reading them here
    // would force a layout, and inside a closed disclosure lay out what is hidden.
    const watch = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize[0];
        if (entry.target === node) width = entry.contentBoxSize[0]?.inlineSize ?? width;
        else if (box) sizes.set(entry.target, box.blockSize);
      }
      const next: Wall = {
        width,
        gap: Number.parseFloat(getComputedStyle(node).rowGap) || 0,
        heights: slots.current.map((slot) => (slot ? sizes.get(slot) : undefined)),
      };
      // why: Placed in the same frame it was measured, so no frame shows the cards unplaced.
      flushSync(() => setWall((shown) => (sameWall(shown, next) ? shown : next)));
    });
    watch.observe(node);
    for (const slot of slots.current) if (slot) watch.observe(slot);
    observer.current = watch;
    return () => {
      watch.disconnect();
      observer.current = null;
    };
  }, []);

  return (
    <VStack ref={wallRef} gap={3} style={isPlaced ? { position: 'relative', height } : undefined}>
      {cards.map((card, at) => {
        const place = places[at];
        return (
          <div
            key={keyOf(card, at)}
            ref={slotRef(at)}
            style={
              isPlaced && place
                ? {
                    position: 'absolute',
                    top: place.top,
                    left: place.column * (columnWidth + wall.gap),
                    width: columnWidth,
                  }
                : undefined
            }
          >
            {card}
          </div>
        );
      })}
    </VStack>
  );
}
