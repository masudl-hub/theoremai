import { HStack } from '@astryxdesign/core/HStack';
import { StackItem } from '@astryxdesign/core/Stack';
import { VStack } from '@astryxdesign/core/VStack';
import { Children, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { columnCount, wallColumns } from './wall-columns.ts';

type Wall = { width: number; gap: number; heights: readonly (number | undefined)[] };

/** The wall's width and gap, and each card's height by its place in `children`. */
function measureWall(
  wall: HTMLElement,
  stacks: readonly (HTMLElement | null)[],
  placed: readonly (readonly number[])[],
  cards: number,
): Wall {
  const heights: (number | undefined)[] = Array.from({ length: cards });
  placed.forEach((column, at) => {
    const shown = stacks[at]?.children;
    column.forEach((card, row) => {
      const element = shown?.[row];
      if (element instanceof HTMLElement) heights[card] = element.offsetHeight;
    });
  });
  const gap = Number.parseFloat(getComputedStyle(wall).columnGap) || 0;
  return { width: wall.clientWidth, gap, heights };
}

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
 * leave a hole beside a tall one.
 */
export function CardWall({ minWidth, children }: { minWidth: number; children: ReactNode }) {
  const cards = Children.toArray(children);
  const wallRef = useRef<HTMLElement>(null);
  const stacks = useRef<(HTMLElement | null)[]>([]);
  const [wall, setWall] = useState<Wall>({ width: 0, gap: 0, heights: [] });
  const placed = wallColumns(
    cards.map((_, at) => wall.heights[at]),
    columnCount(wall.width, minWidth, wall.gap),
    wall.gap,
  );
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const layout = placed.map((column) => column.join(' ')).join('|');

  useLayoutEffect(() => {
    const node = wallRef.current;
    if (!node || !layout) return;
    const measure = () => {
      const next = measureWall(node, stacks.current, placedRef.current, cards.length);
      setWall((shown) => (sameWall(shown, next) ? shown : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const stack of stacks.current) {
      for (const card of stack?.children ?? []) observer.observe(card);
    }
    return () => observer.disconnect();
  }, [layout, cards.length]);

  return (
    <HStack ref={wallRef} gap={3} vAlign="start">
      {placed.map((column, at) => (
        <StackItem key={String(at)} size="fill">
          <VStack
            ref={(node) => {
              stacks.current[at] = node;
            }}
            gap={3}
          >
            {column.map((card) => cards[card])}
          </VStack>
        </StackItem>
      ))}
    </HStack>
  );
}
