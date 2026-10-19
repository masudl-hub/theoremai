import { Text } from '@astryxdesign/core/Text';
import { type PointerEvent, useEffect, useRef, useState } from 'react';
import type { EmbeddingSpace, SpacePoint } from '../client/embedding-space.ts';
import type { QueryMatch } from '../client/space-geometry.ts';
import { createSpaceRenderer, type SpaceRenderer } from './embedding-space-gl.ts';

/** Times the GPU may drop the space before it is listed instead. */
const LOSSES = 2;
/** Pixels a press moves before it counts as turning the sphere, not pointing. */
const DRAG_PX = 3;

export type EmbeddingSpaceViewProps = {
  space: EmbeddingSpace;
  /** Where the last query landed, or `null` before any. */
  query: SpacePoint | null;
  matches: readonly QueryMatch[];
  hovered: number | null;
  onHover(index: number | null): void;
  /** A document's name, as the matches list words it. */
  nameOf(index: number): string;
  /** What the canvas says to a screen reader. */
  label: string;
  /** The browser cannot draw the space. */
  onUnavailable(): void;
};

function isStill(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function SpaceCanvas({
  space,
  query,
  matches,
  hovered,
  onHover,
  nameOf,
  label,
  onUnavailable,
  onLost,
}: EmbeddingSpaceViewProps & { onLost(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<(SpaceRenderer & { destroy(): void }) | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const failed = useRef(onUnavailable);
  failed.current = onUnavailable;
  const lost = useRef(onLost);
  lost.current = onLost;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      rendererRef.current = createSpaceRenderer(canvas, { still: isStill() });
    } catch {
      failed.current();
      return;
    }
    const onContextLost = (event: Event) => {
      event.preventDefault();
      lost.current();
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    return () => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setSpace(space);
  }, [space]);

  useEffect(() => {
    rendererRef.current?.setFocus({ query, matches, hovered });
  }, [query, matches, hovered]);

  const at = (event: PointerEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '1 / 1', maxHeight: 460 }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          cursor: hovered === null ? 'grab' : 'pointer',
          // why: a vertical swipe still scrolls the page; only a sideways one turns the sphere.
          touchAction: 'pan-y',
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          press.current = { ...at(event), moved: false };
        }}
        onPointerMove={(event) => {
          const point = at(event);
          const held = press.current;
          if (held) {
            const dx = point.x - held.x;
            const dy = point.y - held.y;
            if (!held.moved && Math.hypot(dx, dy) < DRAG_PX) return;
            held.moved = true;
            rendererRef.current?.drag(dx, dy);
            press.current = { ...point, moved: true };
            return;
          }
          onHover(rendererRef.current?.pick(point.x, point.y) ?? null);
        }}
        onPointerUp={() => {
          press.current = null;
          rendererRef.current?.release();
        }}
        onPointerCancel={() => {
          press.current = null;
          rendererRef.current?.release();
        }}
        onPointerLeave={() => {
          if (!press.current) onHover(null);
        }}
      />
      {hovered !== null ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
          <Text type="supporting" maxLines={1}>
            {nameOf(hovered)}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The index drawn as a space: each document a dot, a line only between two
 * documents whose cosine similarity stands out from the index's typical pair,
 * documents the lines connect in one colour, and a query's ring with a line to
 * each match that stands out the same way. Drag to turn it; point at a dot to
 * name its document.
 */
export function EmbeddingSpaceView(props: EmbeddingSpaceViewProps) {
  // why: a lost GPU context does not come back on the same canvas; a new one asks again.
  const [generation, setGeneration] = useState(0);
  const onLost = () => {
    if (generation >= LOSSES) props.onUnavailable();
    else setGeneration(generation + 1);
  };
  return <SpaceCanvas key={generation} {...props} onLost={onLost} />;
}
