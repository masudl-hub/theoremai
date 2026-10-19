import { Grid, GridSpan } from '@astryxdesign/core/Grid';
import { Children, type ReactNode, useLayoutEffect, useRef, useState } from 'react';

/** One row of the wall. A card spans as many as its height and the gap below it need. */
const ROW_PX = 4;

function WallCard({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<number>();
  useLayoutEffect(() => {
    const card = ref.current;
    const wall = card?.parentElement;
    if (!card || !wall) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(wall).columnGap) || 0;
      setRows(Math.ceil((card.offsetHeight + gap) / ROW_PX));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  return (
    <GridSpan ref={ref} rows={rows}>
      {children}
    </GridSpan>
  );
}

/**
 * Cards in as many columns as fit, each as tall as its content. A card goes
 * up under the shortest column so far, so short cards never leave a hole
 * beside a tall one.
 */
export function CardWall({ minWidth, children }: { minWidth: number; children: ReactNode }) {
  return (
    <Grid
      columns={{ minWidth, repeat: 'fill' }}
      rowHeight={ROW_PX}
      rowGap={0}
      columnGap={3}
      align="start"
    >
      {Children.map(children, (card) => (
        <WallCard>{card}</WallCard>
      ))}
    </Grid>
  );
}
