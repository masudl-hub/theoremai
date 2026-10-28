import { VStack } from '@astryxdesign/core/VStack';
import { Children, isValidElement, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
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
    const measure = () => {
      const next: Wall = {
        width: node.clientWidth,
        gap: Number.parseFloat(getComputedStyle(node).rowGap) || 0,
        heights: slots.current.map((slot) => slot?.offsetHeight),
      };
      setWall((shown) => (sameWall(shown, next) ? shown : next));
    };
    measure();
    const watch = new ResizeObserver(measure);
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
            ref={(slot) => {
              slots.current[at] = slot;
              // why: A card that mounts later is measured once it is watched.
              if (slot) observer.current?.observe(slot);
              return () => {
                if (slot) observer.current?.unobserve(slot);
              };
            }}
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
