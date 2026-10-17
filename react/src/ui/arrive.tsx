import { type CSSProperties, createContext, type ReactNode, use, useRef, useState } from 'react';

/**
 * How long each later item waits. Short enough that a handful still read as
 * one arrival, long enough that the order is visible.
 */
const STEP_MS = 64;
/** Past this, the rest start together so a long list is not still waiting. */
const CAP = 10;

const ArriveSeq = createContext<{ current: number } | null>(null);

/**
 * Items under this ease in one after another, in tree order. An item that
 * mounts later (a span that just landed, a chart whose module just loaded)
 * eases in on its own. Already-shown items do not replay.
 */
export function Stream({ children }: { children: ReactNode }) {
  const seq = useRef(0);
  // why: Each render starts again. Items remember the place they took, so a
  // re-render does not hand that place to someone else.
  seq.current = 0;
  return <ArriveSeq value={seq}>{children}</ArriveSeq>;
}

/** Class and delay for one item. Nothing outside a {@link Stream}. */
export function useArrive(): { className: string; style?: CSSProperties } | null {
  const seq = use(ArriveSeq);
  const slot = useRef<number | null>(null);
  if (seq && slot.current === null) {
    slot.current = seq.current;
    seq.current += 1;
  }
  const index = seq ? slot.current : null;
  const [delay] = useState(() => (index === null ? 0 : Math.min(index, CAP) * STEP_MS));
  if (index === null) return null;
  return {
    className: 'theorem-arrive',
    style: delay > 0 ? { animationDelay: `${String(delay)}ms` } : undefined,
  };
}

/** A block that eases in with its siblings under {@link Stream}. */
export function Arrive({ children }: { children: ReactNode }) {
  const arrive = useArrive();
  if (!arrive) return children;
  return (
    <div className={arrive.className} style={arrive.style}>
      {children}
    </div>
  );
}
